import { Router } from "express";
import { getReport, triggerReport } from "../controllers/reportController";
const reportRoutes = Router();
reportRoutes.post("/trigger_report", triggerReport);
reportRoutes.get("/get_report/:id", getReport);
export default reportRoutes;
//# sourceMappingURL=reportRoutes.js.map