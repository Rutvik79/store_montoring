import { PrismaClient } from "@prisma/client";
import type { Request, Response } from "express";
import path from "path";
import { v4 as uuid } from "uuid";
import { generateReport } from "../services/reportService";

const prisma = new PrismaClient();

export async function triggerReport(req: Request, res: Response) {
  try {
    const reportId = uuid();

    await prisma.report.create({
      data: { id: reportId, status: "RUNNING", filePath: "" },
    });

    // async job (dont block response)
    generateReport(reportId);

    res.json({ reportId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to trigger report" });
  }
}

export const getReport = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(404).json({ error: "ReportId not found" });
    }

    const report = await prisma.report.findUnique({ where: { id } });

    if (!report) return res.status(404).json({ error: "Report not found" });

    if (report.status === "RUNNING") {
      return res.json({ reportId: report.id, status: "Running" });
    }

    if (report.status === "FAILED") {
      return res.json({ reportId: report.id, status: "FAILED" });
    }

    if (report.filePath) {
      return res.download(report.filePath, path.basename(report.filePath));
    }

    return res.json({ reportId: report.id, status: report.status });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch report" });
  }
};

// export const downloadReport = async (req: Request, res: Response) {

// }
