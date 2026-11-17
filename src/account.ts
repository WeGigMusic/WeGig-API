import { Router } from "express";
import {
  requireAccountDeletionAuth,
  type AuthedRequest,
} from "./auth";
import {
  AccountDeletionError,
  deleteAccount,
} from "./accountDeletion";

const router = Router();

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.delete(
  "/",
  requireAccountDeletionAuth,
  async (req: AuthedRequest, res) => {
    if (req.body?.confirmation !== "DELETE") {
      return res.status(400).json({
        code: "DELETION_CONFIRMATION_REQUIRED",
        message: "Confirm that you want to delete your account.",
      });
    }

    try {
      await deleteAccount(req.user!.id);

      return res.status(200).json({
        deleted: true,
      });
    } catch (error) {
      if (error instanceof AccountDeletionError) {
        return res.status(error.status).json({
          code: error.code,
          message:
            "Account deletion could not finish. Please retry to complete it.",
        });
      }

      return res.status(503).json({
        code: "ACCOUNT_DELETION_RETRY_REQUIRED",
        message:
          "Account deletion could not finish. Please retry to complete it.",
      });
    }
  },
);

export default router;