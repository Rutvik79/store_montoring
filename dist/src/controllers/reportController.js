import { PrismaClient } from "@prisma/client";
import path from "path";
import { v4 as uuid } from "uuid";
import { generateReport } from "../services/reportService";
const prisma = new PrismaClient();
export async function triggerReport(req, res) {
    try {
        const reportId = uuid();
        await prisma.report.create({
            data: { id: reportId, status: "RUNNING", filePath: "" },
        });
        // async job (dont block response)
        generateReport(reportId);
        res.json({ reportId });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to trigger report" });
    }
}
export const getReport = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.status(404).json({ error: "ReportId not found" });
        }
        const report = await prisma.report.findUnique({ where: { id } });
        if (!report)
            return res.status(404).json({ error: "Report not found" });
        if (report.status === "COMPLETE") {
            res.json({
                reportId: report.id,
                status: report.status,
                downloadUrl: `reports/${path.basename(report.filePath)}`,
                filePath: report.filePath,
            });
        }
        else {
            res.json({ reportId: report.id, status: report.status });
        }
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch report" });
    }
};
// export const downloadReport = async (req: Request, res: Response) {
// }
//# sourceMappingURL=reportController.js.map