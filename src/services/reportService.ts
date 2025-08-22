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
  const tzRow = await prisma.storeTimezone.findUnique({
    where: { storeId },
  });
  const timezone = tzRow?.timezone || "America/Chicago";

  const globalLatest = await prisma.storeStatus.findFirst({
    orderBy: { timestampUtc: "desc" },
  });

  if (!globalLatest) return emptyMetrics();

  const now = DateTime.fromJSDate(globalLatest.timestampUtc, { zone: "utc" });
  const hourAgo = now.minus({ hours: 1 });
  const dayAgo = now.minus({ days: 1 });
  const weekAgo = now.minus({ weeks: 1 });

  // fetch all statuses for this store in max window (week)
  const statuses = await prisma.storeStatus.findMany({
    where: {
      storeId,
      timestampUtc: { gte: weekAgo.toJSDate(), lte: now.toJSDate() },
    },
    orderBy: { timestampUtc: "asc" },
  });

  // fetch last status before the window once
  const prevStatus = await prisma.storeStatus.findFirst({
    where: { storeId, timestampUtc: { lt: weekAgo.toJSDate() } },
    orderBy: { timestampUtc: "desc" },
  });

  // load business hours once
  const businessHours = await prisma.businessHours.findMany({
    where: { storeId },
  });
  const useBusinessHours = businessHours.length > 0;

  // pass preloaded statuses
  const lastHour = computeForPeriod(
    statuses,
    prevStatus,
    hourAgo,
    now,
    timezone,
    businessHours,
    useBusinessHours
  );
  const lastDay = computeForPeriod(
    statuses,
    prevStatus,
    dayAgo,
    now,
    timezone,
    businessHours,
    useBusinessHours
  );
  const lastWeek = computeForPeriod(
    statuses,
    prevStatus,
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

function computeForPeriod(
  allStatuses: { timestampUtc: Date; status: string }[],
  prevStatus: { timestampUtc: Date; status: string } | null,
  start: DateTime,
  end: DateTime,
  timezone: string,
  businessHours: { dayOfWeek: number; startTime: string; endTime: string }[],
  useBusinessHours: boolean
) {
  let openIntervals: { start: DateTime; end: DateTime }[] = [];

  if (useBusinessHours) {
    let cursor = start.startOf("day");
    while (cursor <= end) {
      const dayOfWeek = (cursor.weekday + 6) % 7;
      const todayHours = businessHours.filter(
        (bh) => bh.dayOfWeek === dayOfWeek
      );

      for (const bh of todayHours) {
        const [sh, sm, ss] = bh.startTime.split(":").map(Number);
        const [eh, em, es] = bh.endTime.split(":").map(Number);

        const localStart = cursor.set({ hour: sh, minute: sm, second: ss });
        const localEnd = cursor.set({ hour: eh, minute: em, second: es });

        const utcStart = localStart.setZone(timezone).toUTC();
        const utcEnd = localEnd.setZone(timezone).toUTC();

        const intervalStart = utcStart < start ? start : utcStart;
        const intervalEnd = utcEnd > end ? end : utcEnd;

        if (intervalStart < intervalEnd)
          openIntervals.push({ start: intervalStart, end: intervalEnd });
      }

      cursor = cursor.plus({ days: 1 });
    }
  } else {
    openIntervals = [{ start, end }];
  }

  let uptimeMinutes = 0;
  let downtimeMinutes = 0;

  for (const interval of openIntervals) {
    const relevant = allStatuses.filter((s) => {
      const t = DateTime.fromJSDate(s.timestampUtc, { zone: "utc" });
      return t >= interval.start && t <= interval.end;
    });

    let cursorTime = interval.start;
    let lastStatus = prevStatus ?? relevant[0];

    if (!relevant.length) {
      const duration = interval.end.diff(interval.start, "minutes").minutes;
      if (lastStatus?.status === "active") uptimeMinutes += duration;
      else downtimeMinutes += duration;
      continue;
    }

    for (const curr of relevant) {
      const currTime = DateTime.fromJSDate(curr.timestampUtc, { zone: "utc" });
      const duration = currTime.diff(cursorTime, "minutes").minutes;
      if (lastStatus?.status === "active") uptimeMinutes += duration;
      else downtimeMinutes += duration;
      cursorTime = currTime;
      lastStatus = curr;
    }

    const tailDuration = interval.end.diff(cursorTime, "minutes").minutes;
    if (lastStatus?.status === "active") uptimeMinutes += tailDuration;
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
