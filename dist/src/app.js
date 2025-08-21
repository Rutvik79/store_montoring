import express from "express";
import helmet from "helmet";
import cors from "cors";
import reportRoutes from "./routes/reportRoutes";
import path from "path";
const app = express();
// middle
app.use(helmet());
app.use(cors());
app.use(express.json());
// Routes
app.use("/reports", express.static(path.join(process.cwd(), "reports")), reportRoutes);
export default app;
//# sourceMappingURL=app.js.map