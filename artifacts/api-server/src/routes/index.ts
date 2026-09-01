import { Router, type IRouter } from "express";
import healthRouter from "./health";
import platformRouter from "./platform";
import membersRouter from "./members";

const router: IRouter = Router();

router.use(healthRouter);
router.use(platformRouter);
router.use(membersRouter);

export default router;
