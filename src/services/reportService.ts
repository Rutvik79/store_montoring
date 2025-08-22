import { PrismaClient, ReportStatus } from "@prisma/client";
import path from "path";
import fs from "fs";
import { DateTime } from "luxon";
import { report } from "process";

const prisma = new PrismaClient();
export async function generateReport(reportId: string) {
  try {
    console.log(`Generating real report ${reportId}`);

    const reportsDir = path.join(process.cwd(), "reports");

    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir);
    }

    const filePath = path.join(reportsDir, `${reportId}.csv`);

    // 1.Get all stores
    // 1. Get all unique storeIds
    const storeStatuses = await prisma.storeStatus.findMany({
      select: { storeId: true },
    });

    const stores = Array.from(new Set(storeStatuses.map((s) => s.storeId))).map(
      (id) => ({ storeId: id })
    );

    // csv header
    const header = [
      "store_id",
      "uptime_last_hour(in minutes)",
      "uptime_last_day(in hours)",
      "uptime_last_week(in hours)",
      "downtime_last_hour(in minutes)",
      "downtime_last_day(in hours)",
      "downtime_last_week(in hours)",
    ];

    const rows: (string | number)[][] = [header];

    // 3. loop through stores and complete metrics
    for (const store of stores) {
      const metrics = await computeMetrics(store.storeId);

      rows.push([
        store.storeId,
        metrics.uptimeHour,
        metrics.uptimeDay,
        metrics.uptimeWeek,
        metrics.downtimeHour,
        metrics.downtimeDay,
        metrics.downtimeWeek,
      ]);
    }

    // 4. write csv
    const csvContent = rows.map((r) => r.join(",")).join("\n");
    await fs.promises.writeFile(filePath, csvContent);

    // 5 . Update report status in DB
    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: "COMPLETE",
        filePath,
      },
    });

    console.log(`Report ${reportId} completed and saved to ${filePath}`);
  } catch (error) {
    console.error(`Error generating report: ${reportId}`, error);

    // if something goes wrong, mark report as FAILED
    await prisma.report.update({
      where: { id: reportId },
      data: {
        status: "FAILED",
      },
    });
  }
}

// Helpers

async function computeMetrics(storeId: string) {
  // 1. get time zone (default = America/Chicago)
  const tzRow = await prisma.storeTimezone.findUnique({
    where: { storeId },
  });
  const timezone = tzRow?.timezone || "America/Chicago";

  // 2. get latest status timestamp (define "now")
  const globalLatest = await prisma.storeStatus.findFirst({
    orderBy: { timestampUtc: "desc" },
  });

  if (!globalLatest) {
    return emptyMetrics();
  }

  const now = DateTime.fromJSDate(globalLatest.timestampUtc, { zone: "utc" });

  // 3. Define periods
  const hourAgo = now.minus({ hours: 1 });
  const dayAgo = now.minus({ days: 1 });
  const weekAgo = now.minus({ weeks: 1 });

  // 4. Load business hours once
  const businessHours = await prisma.businessHours.findMany({
    where: { storeId },
  });

  const useBusinessHours = businessHours.length > 0;

  // 5. Compute metrics for each window
  const lastHour = await computeForPeriod(
    storeId,
    hourAgo,
    now,
    timezone,
    businessHours,
    useBusinessHours
  );
  const lastDay = await computeForPeriod(
    storeId,
    dayAgo,
    now,
    timezone,
    businessHours,
    useBusinessHours
  );
  const lastWeek = await computeForPeriod(
    storeId,
    weekAgo,
    now,
    timezone,
    businessHours,
    useBusinessHours
  );

  return {
    uptimeHour: lastHour.uptimeMinutes,
    downtimeHour: lastHour.downtimeMinutes,
    uptimeDay: lastDay.uptimeHours,
    downtimeDay: lastDay.downtimeHours,
    uptimeWeek: lastWeek.uptimeHours,
    downtimeWeek: lastWeek.downtimeHours,
  };
}

async function computeForPeriod(
  storeId: string,
  start: DateTime,
  end: DateTime,
  timezone: string,
  businessHours: { dayOfWeek: number; startTime: string; endTime: string }[],
  useBusinessHours: boolean
) {
  // 1. Get statuses in the period
  const statuses = await prisma.storeStatus.findMany({
    where: {
      storeId,
      timestampUtc: {
        gte: start.toJSDate(),
        lte: end.toJSDate(),
      },
    },
    orderBy: { timestampUtc: "asc" },
  });

  // 2. Build open intervals in UTC
  let openIntervals: { start: DateTime; end: DateTime }[] = [];

  if (useBusinessHours) {
    let cursor = start.startOf("day");
    while (cursor <= end) {
      const dayOfWeek = (cursor.weekday + 6) % 7; // Luxon Mon=1..Sun=7
      const todayHours = businessHours.filter(
        (bh) => bh.dayOfWeek === dayOfWeek
      );

      for (const bh of todayHours) {
        const [startH, startM, startS] = bh.startTime.split(":").map(Number);
        const [endH, endM, endS] = bh.endTime.split(":").map(Number);

        const localStart = cursor.set({
          hour: startH,
          minute: startM,
          second: startS,
        });
        const localEnd = cursor.set({
          hour: endH,
          minute: endM,
          second: endS,
        });

        const utcStart = localStart.setZone(timezone).toUTC();
        const utcEnd = localEnd.setZone(timezone).toUTC();

        // clip to [start, end]
        const intervalStart = utcStart < start ? start : utcStart;
        const intervalEnd = utcEnd > end ? end : utcEnd;

        if (intervalStart < intervalEnd) {
          openIntervals.push({ start: intervalStart, end: intervalEnd });
        }
      }

      cursor = cursor.plus({ days: 1 });
    }
  } else {
    // Open 24/7
    openIntervals = [{ start, end }];
  }

  // 3. Iterate statuses only within open intervals
  let uptimeMinutes = 0;
  let downtimeMinutes = 0;

  for (const interval of openIntervals) {
    // fetch prevStatus just before this interval
    const intervalPrevStatus = await prisma.storeStatus.findFirst({
      where: {
        storeId,
        timestampUtc: { lt: interval.start.toJSDate() },
      },
      orderBy: { timestampUtc: "desc" },
    });

    const relevantStatuses = statuses.filter(
      (s) =>
        DateTime.fromJSDate(s.timestampUtc, { zone: "utc" }) >=
          interval.start &&
        DateTime.fromJSDate(s.timestampUtc, { zone: "utc" }) <= interval.end
    );

    // Case A: No statuses in interval
    if (relevantStatuses.length === 0) {
      const duration = interval.end.diff(interval.start, "minutes").minutes;
      if (intervalPrevStatus?.status === "active") uptimeMinutes += duration;
      else downtimeMinutes += duration;
      continue;
    }

    // Case B: Seed with intervalPrevStatus (or first status inside interval)
    let cursorTime = interval.start;
    let lastStatus = intervalPrevStatus ?? relevantStatuses[0];

    for (const curr of relevantStatuses) {
      const currTime = DateTime.fromJSDate(curr.timestampUtc, { zone: "utc" });
      const duration = currTime.diff(cursorTime, "minutes").minutes;

      if (lastStatus!.status === "active") uptimeMinutes += duration;
      else downtimeMinutes += duration;

      cursorTime = currTime;
      lastStatus = curr;
    }

    // Fill from last status to interval end
    const tailDuration = interval.end.diff(cursorTime, "minutes").minutes;
    if (lastStatus!.status === "active") uptimeMinutes += tailDuration;
    else downtimeMinutes += tailDuration;
  }

  return {
    uptimeMinutes: Math.round(uptimeMinutes),
    downtimeMinutes: Math.round(downtimeMinutes),
    uptimeHours: +(uptimeMinutes / 60).toFixed(2),
    downtimeHours: +(downtimeMinutes / 60).toFixed(2),
  };
}

function emptyMetrics() {
  return {
    uptimeHour: 0,
    downtimeHour: 60,
    uptimeDay: 0,
    downtimeDay: 24,
    uptimeWeek: 0,
    downtimeWeek: 24 * 7,
  };
}
