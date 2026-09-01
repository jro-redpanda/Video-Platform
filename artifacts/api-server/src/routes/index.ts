import { Router, type IRouter } from "express";
import healthRouter from "./health";
import platformRouter from "./platform";

const router: IRouter = Router();

router.use(healthRouter);
router.use(platformRouter);

export default router;
