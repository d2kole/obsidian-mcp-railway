import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { buildMcpRouter } from "../mcp/transport";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/mcp", buildMcpRouter());

export default router;
