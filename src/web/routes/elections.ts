import { Router, Request, Response } from "express";
import * as electionService from "../../bot/services/election";
import path from "path";

const router = Router();

router.get("/:id", async (req: Request, res: Response) => {
  const election = await electionService.getElection(req.params.id as string);
  if (!election) {
    res.status(404).send("選挙が見つかりません。");
    return;
  }
  res.sendFile(path.join(__dirname, "../public/election.html"));
});

export { router as electionRoutes };
