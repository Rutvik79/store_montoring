import { PrismaClient } from "@prisma/client";
import path from "path";
import fs from "fs";
import { DateTime } from "luxon";

const prisma = new PrismaClient();
export async function generateReport(reportId: string) {
  try {
    console.log(`Generating real report ${reportId}`);

    // check if reports directory exists? if not create reports directory
    const reportsDir = path.join(process.cwd(), "reports");
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir);
    }

    const filePath = path.join(reportsDir, `${reportId}.csv`);

    // 1. Preload all data from storeStatus table at once
    const globalLatest = await prisma.storeStatus.findFirst({
      orderBy: { timestampUtc: "desc" },
    }); // get the latest status from any store to calculate the most recent time the status data was retrieved
    if (!globalLatest) {
      throw new Error("No store statuses found"); // if not found that means the storeStatus file is empty
    }

    const now = DateTime.fromJSDate(globalLatest.timestampUtc, { zone: "utc" }); // gets the most recent time the store status for any store was calculated
    const hourAgo = now.minus({ hours: 1 }); // to calculate the hour ago data
    const dayAgo = now.minus({ days: 1 }); // to calculate the day ago data
    const weekAgo = now.minus({ week: 1 }); // to calculate the week ago data

    // a. statuses in last week
    const statuses = await prisma.storeStatus.findMany({
      where: { timestampUtc: { gte: weekAgo.toJSDate(), lte: now.toJSDate() } },
      orderBy: { timestampUtc: "asc" },
    }); // gets all statuses for all stores in the last 7 days

    // b. last status in a week window
    const prevStatuses = await prisma.storeStatus.groupBy({
      by: ["storeId"],
      _max: { timestampUtc: true },
      where: {
        timestampUtc: { lt: weekAgo.toJSDate() },
      },
    }); // groups statuses by storeId, but only for timestamps before the 1-week window,
    //  so that we can calculate the uptime/downtime at weekago, we need to know the stores last known state just before that time

    const prevStatusMap: Record<string, any> = {};
    for (const row of prevStatuses) {
      if (row._max.timestampUtc) {
        const ps = await prisma.storeStatus.findFirst({
          where: { storeId: row.storeId, timestampUtc: row._max.timestampUtc },
        });

        if (ps) {
          prevStatusMap[row.storeId] = ps;
        }
      }
    } // loops through each store's _max.timestampUtc(the last before the 1-week window),
    //  fetch the status row and saves it to dictionary

    // c. business hours + timezones
    const businessHours = await prisma.businessHours.findMany(); // pull all records from business hours and timezoes tables
    const timezones = await prisma.storeTimezone.findMany(); // since its cheaper and faster to load everything at once

    // create maps for all data using storeId as key to effiecient lookup
    const hoursByStore = businessHours.reduce((acc, bh) => {
      (acc[bh.storeId] ||= []).push(bh);
      return acc;
    }, {} as Record<string, typeof businessHours>);

    const tzByStore = timezones.reduce((acc, tz) => {
      acc[tz.storeId] = tz.timezone;
      return acc;
    }, {} as Record<string, string>);

    // group statuses per store
    const statusesByStore = statuses.reduce((acc, s) => {
      (acc[s.storeId] ||= []).push(s);
      return acc;
    }, {} as Record<string, typeof statuses>);

    // 2. prepare csv
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

    const storeIds = Array.from(new Set(statuses.map((s) => s.storeId)));

    for (const storeId of storeIds) {
      // fetch all data from the maps created above
      const storeStatuses = statusesByStore[storeId] || []; // statuses by store
      const prevStatus = prevStatusMap[storeId] || null; // prev status before a week
      const bh = hoursByStore[storeId] || []; // business hours by storeID
      const tz = tzByStore[storeId] || "America/Chicago"; // timezones by storeID
      const useBH = bh.length > 0; // if business hours [] is empty that means the store is open 24/7

      const lastHour = computeForPeriod(
        storeStatuses,
        prevStatus,
        hourAgo,
        now,
        tz,
        bh,
        useBH
      ); // compute uptime, downtime in minutes, hours
      const lastDay = computeForPeriod(
        storeStatuses,
        prevStatus,
        dayAgo,
        now,
        tz,
        bh,
        useBH
      ); // compute uptime, downtime in minutes, hours
      const lastWeek = computeForPeriod(
        storeStatuses,
        prevStatus,
        weekAgo,
        now,
        tz,
        bh,
        useBH
      ); // compute uptime, downtime in minutes, hours

      rows.push([
        storeId,
        lastHour.uptimeMinutes,
        lastDay.uptimeHours,
        lastWeek.uptimeHours,
        lastHour.downtimeMinutes,
        lastDay.downtimeHours,
        lastWeek.downtimeHours,
      ]);
    }

    const csvContent = rows.map((r) => r.join(",")).join("\n");
    await fs.promises.writeFile(filePath, csvContent);

    // 3. update report status
    await prisma.report.update({
      where: { id: reportId },
      data: { status: "COMPLETE", filePath },
    });

    console.log(`Report ${reportId} completed and saved to ${filePath}`);
  } catch (error) {
    console.error(`Error generating report: ${reportId}`, error);

    await prisma.report.update({
      where: {
        id: reportId,
      },
      data: {
        status: "FAILED",
      },
    });
  }
}

// Helpers

function computeForPeriod(
  allStatuses: { timestampUtc: Date; status: string }[],
  prevStatus: { timestampUtc: Date; status: string } | null,
  start: DateTime,
  end: DateTime,
  timezone: string,
  businessHours: { dayOfWeek: number; startTime: string; endTime: string }[],
  useBusinessHours: boolean
) {
  let openIntervals: { start: DateTime; end: DateTime }[] = []; // store intervals during business hours in UTC
  // during which the store is considered 'open' and stored as [start, end]

  if (useBusinessHours) {
    let cursor = start.startOf("day"); // start from begining of the first day in report window
    while (cursor <= end) {
      const dayOfWeek = (cursor.weekday + 6) % 7; // 0=Monday, 6=Sunday in db schema, but for luxon 1=Monday, 7=Sunday

      const todayHours = businessHours.filter(
        (bh) => bh.dayOfWeek === dayOfWeek
      ); //get business hour ranges for this store on the weekday

      for (const bh of todayHours) {
        const [sh, sm, ss] = bh.startTime.split(":").map(Number); //start time in (HH:mm:ss)
        const [eh, em, es] = bh.endTime.split(":").map(Number); //end time in (HH:mm:ss)

        const localStart = cursor.set({ hour: sh, minute: sm, second: ss }); // set local start time
        const localEnd = cursor.set({ hour: eh, minute: em, second: es }); // set local end time

        const utcStart = localStart.setZone(timezone).toUTC(); // set utc start time
        const utcEnd = localEnd.setZone(timezone).toUTC(); // set utc end time
        // so that the can be compared consistently with status timestamps

        const intervalStart = utcStart < start ? start : utcStart;
        const intervalEnd = utcEnd > end ? end : utcEnd;
        // cut interval so it stays within the window[start, end]
        // eg: if report starts at 10:00 but business hours are 08:00 - 17:00 we only care from 10:00-17:00

        if (intervalStart < intervalEnd)
          openIntervals.push({ start: intervalStart, end: intervalEnd }); // store interval in array
      }

      cursor = cursor.plus({ days: 1 });
    }
  } else {
    openIntervals = [{ start, end }]; // if store has no defined business hours, treaat the entire [start, end] as open.
  }

  let uptimeMinutes = 0;
  let downtimeMinutes = 0;
  // total across all open intervals for this store

  for (const interval of openIntervals) {
    // foreach open window from business hours in UTC
    const relevant = allStatuses.filter((s) => {
      const t = DateTime.fromJSDate(s.timestampUtc, { zone: "utc" });
      return t >= interval.start && t <= interval.end;
    }); //filter all status event that occured inside the interval

    let cursorTime = interval.start;
    let lastStatus = prevStatus ?? relevant[0]; // what was the stores state at the begining of the interval

    if (!relevant.length) {
      // case: no status updates in interval
      const duration = interval.end.diff(interval.start, "minutes").minutes;
      if (lastStatus?.status === "active") uptimeMinutes += duration;
      else downtimeMinutes += duration;
      // if status was last know active the assume it stayed active the whole time, else inactive
      continue; // done with interval
    }

    // case: there are status changes inside interval
    for (const curr of relevant) {
      const currTime = DateTime.fromJSDate(curr.timestampUtc, { zone: "utc" });
      const duration = currTime.diff(cursorTime, "minutes").minutes;
      // span since the last cursor point.
      if (lastStatus?.status === "active") uptimeMinutes += duration;
      else downtimeMinutes += duration;
      cursorTime = currTime;
      lastStatus = curr;
    }

    // time between last event and interval end
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
