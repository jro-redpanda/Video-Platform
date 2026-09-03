import { Router, type IRouter } from "express";
import platformRouter from "./platform";
import membersRouter from "./members";
import foldersRouter from "./folders";
import thumbnailsRouter from "./thumbnails";
import billingRouter from "./billing";
import customDomainRouter from "./custom-domain";
import masterStorageRouter from "./master-storage";

const router: IRouter = Router();

router.use(platformRouter);
router.use(membersRouter);
router.use(foldersRouter);
router.use(thumbnailsRouter);
router.use(billingRouter);
router.use(customDomainRouter);
router.use(masterStorageRouter);

export default router;
