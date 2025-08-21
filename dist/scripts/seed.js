import { PrismaClient, StoreState } from "@prisma/client";
import csvParser from "csv-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const prisma = new PrismaClient();
async function loadCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csvParser())
            .on("data", (data) => results.push(data))
            .on("end", () => resolve(results))
            .on("error", (err) => reject(err));
    });
}
async function main() {
    console.log("Seeding database");
    const statusFile = path.join(__dirname, "../..", "store_status.csv");
    const statusData = await loadCSV(statusFile);
    console.log("Row sample:", statusData[0]);
    await prisma.storeStatus.createMany({
        data: statusData.map((row) => ({
            storeId: row.store_id,
            timestampUtc: new Date(row.timestamp_utc),
            status: row.status.toLowerCase(),
        })),
        skipDuplicates: true, // optional: avoids crashes if CSV has duplicate IDs
    });
    console.log(`Inserted ${statusData.length}, store status rows`);
    const hoursFile = path.join(__dirname, "../..", "menu_hours.csv");
    const hoursData = await loadCSV(hoursFile);
    await prisma.businessHours.createMany({
        data: hoursData.map((row) => ({
            storeId: row.store_id,
            dayOfWeek: parseInt(row.dayOfWeek),
            startTime: row.start_time_local,
            endTime: row.end_time_local,
        })),
        skipDuplicates: true,
    });
    console.log(`Inserted ${hoursData.length} business hours rows`);
    const tzFile = path.join(__dirname, "../..", "timezones.csv");
    const tzData = await loadCSV(tzFile);
    await prisma.storeTimezone.createMany({
        data: tzData.map((row) => ({
            storeId: row.store_id,
            timezone: row.timezone_str || "America/Chicago",
        })),
        skipDuplicates: true,
    });
    console.log(`Inserted ${tzData.length} timezone rows`);
    console.log("Seeding completed");
}
main()
    .catch((e) => {
    console.error(e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=seed.js.map