import { Router, type IRouter } from "express";
import healthRouter from "./health";
import platformRouter from "./platform";
import membersRouter from "./members";
import foldersRouter from "./folders";
import thumbnailsRouter from "./thumbnails";

const router: IRouter = Router();

router.use(healthRouter);
router.use(platformRouter);
router.use(membersRouter);
router.use(foldersRouter);
router.use(thumbnailsRouter);

export default router;
