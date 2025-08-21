import { PrismaClient, ReportStatus } from "@prisma/client";
import path from "path";
import fs from "fs";
const prisma = new PrismaClient();
export async function generateReport(reportId) {
    try {
        console.log(`Mock generating report ${reportId}`);
        // 1. Create a mock CSV content
        const mockData = [
            ["store_id", "uptime_last_hour", "uptime_last_day", "uptime_last_week"],
            ["101", "95%", "96%", "97%"],
            ["102", "88%", "90%", "91%"],
        ];
        // .2. Decide a filepath for the CSV
        const reportsDir = path.join(process.cwd(), "reports");
        if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir);
        }
        const filePath = path.join(reportsDir, `${reportId}.csv`);
        // 3. write csv to disk
        const csvContent = mockData.map((row) => row.join(",")).join("\n");
        fs.writeFileSync(filePath, csvContent);
        // 4. update report status in DB
        await prisma.report.update({
            where: {
                id: reportId,
            },
            data: {
                status: "COMPLETE",
                filePath: filePath,
            },
        });
        console.log(`Report ${reportId} completed and saved to ${filePath}`);
    }
    catch (error) {
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
//# sourceMappingURL=reportService.js.map