import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import translateRouter from "./translate/index.js";
import mediaRouter from "./media/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(translateRouter);
router.use(mediaRouter);

export default router;
