import { createContext } from 'react';
import MatchImportResult, { ImportResultStatus } from '../DataModel/MatchImportResult';
import { Round } from '../DataModel/Round';
import { StatsValidity } from '../DataModel/Match';
import { getFileNameFromPath } from '../Utils/GeneralUtils';
import Tournament from '../DataModel/Tournament';
import type { IResultReviewRequest, ResultReviewDecision } from '../../qbtcp/QbtcpState';

export default class MatchImportResultsManager {
  modalIsOpen: boolean = false;

  round?: Round;

  resultsList?: MatchImportResult[];

  dataChangedReactCallback: () => void;

  constructor() {
    this.dataChangedReactCallback = () => {};
  }

  reset() {
    delete this.round;
    delete this.resultsList;
  }

  openModal(resultsList: MatchImportResult[], round?: Round) {
    this.modalIsOpen = true;
    this.round = round;
    this.resultsList = resultsList;
    this.dataChangedReactCallback();
  }

  closeModal(shouldSave: boolean) {
    if (shouldSave) {
      this.finishImport();
    }
    this.modalIsOpen = false;
    this.reset();
    this.dataChangedReactCallback();
  }

  /**
   * Commit the imports the director accepted.
   *
   * The single place a result becomes a game in the tournament, which is why the scheduled-game guard
   * is here as well as in the review that precedes it. A result carrying a pairing's identity may only
   * create one Match: a scheduled game that already has one is complete, and a second would be two
   * games for one pairing in the standings. The review normally catches this and refuses the import
   * before it gets here; this check is what holds when it did not - a manual file import with no Rooms
   * adapter running, most obviously.
   */
  finishImport() {
    if (!this.resultsList) return;

    for (const res of this.resultsList) {
      if (!res.proceedWithImport || !res.match) continue;
      // An explicit QBTCP Replace is the one path that is allowed to revisit a completed pairing.
      // The old guard must not make the approved correction disappear at commit time.
      if (res.qbtcpReviewAction !== 'supersede' && MatchImportResultsManager.scheduledGameAlreadyPlayed(res)) continue;

      if (res.qbtcpReviewAction === 'supersede' && res.round && res.match.scheduledGameId) {
        const scheduledGame = res.round.findScheduledGameById(res.match.scheduledGameId);
        const existing = scheduledGame ? res.round.getMatchForScheduledGame(scheduledGame) : undefined;
        if (existing) res.round.deleteMatch(existing);
      }

      if (res.status === ImportResultStatus.ErrNonFatal) res.match.statsValidity = StatsValidity.omit;
      res.match.importedFile = getFileNameFromPath(res.filePath);
      Tournament.validateHaveTeamsPlayedInRound(res.match, res.round, res.phase, false);
      if (res.round) res.round.addMatch(res.match);
    }
  }

  /** Whether the pairing this result claims already has a game recorded against it. */
  private static scheduledGameAlreadyPlayed(res: MatchImportResult): boolean {
    const scheduledGameId = res.match?.scheduledGameId;
    if (!scheduledGameId || !res.round) return false;
    const scheduledGame = res.round.findScheduledGameById(scheduledGameId);
    if (!scheduledGame) return false;
    return res.round.scheduledGameIsComplete(scheduledGame);
  }

  setProceedWithImport(rslt: MatchImportResult, val: boolean) {
    rslt.proceedWithImport = val;
    this.dataChangedReactCallback();
  }

  /**
   * Return one explicit decision for every retained QBTCP receipt in the open modal.
   *
   * Clean results default to accept, while a same-Match-ID conflict defaults to keeping the
   * existing result. Both defaults are still sent as explicit review commands, so a modal close
   * can never silently leave a durable receipt in an untracked state.
   */
  getQbtcpReviewDecisions(): Map<string, IResultReviewRequest> {
    const decisions = new Map<string, IResultReviewRequest>();
    for (const result of this.resultsList ?? []) {
      if (!result.qbtcpResultId) continue;
      const { comparison } = result;
      let defaultAction: ResultReviewDecision;
      if (result.qbtcpReviewAction) defaultAction = result.qbtcpReviewAction;
      else if (comparison?.kind === 'conflict') defaultAction = 'keep-existing';
      else defaultAction = result.proceedWithImport ? 'accept' : 'dismiss';
      const existingResultId =
        result.qbtcpExistingResultId ??
        (comparison?.kind === 'conflict' || comparison?.kind === 'duplicate' ? comparison.existingId : undefined);
      // A target-less Keep/Replace cannot be applied by the server. Treat it as a conservative
      // dismissal rather than losing the receipt or pretending it was reconciled.
      const decision: ResultReviewDecision =
        (defaultAction === 'keep-existing' || defaultAction === 'supersede') && !existingResultId
          ? 'dismiss'
          : defaultAction;
      decisions.set(result.qbtcpResultId, {
        decision,
        ...(decision === 'keep-existing' || decision === 'supersede' ? { existingResultId } : {}),
        ...(result.qbtcpReviewReason?.trim() ? { reason: result.qbtcpReviewReason.trim().slice(0, 1000) } : {}),
      });
    }
    return decisions;
  }

  setQbtcpReviewAction(
    result: MatchImportResult,
    action: ResultReviewDecision,
    existingResultId?: string,
    reason?: string,
  ) {
    if (!result.qbtcpResultId) return;
    result.qbtcpReviewAction = action;
    result.qbtcpExistingResultId = existingResultId;
    result.qbtcpReviewReason = reason;
    result.proceedWithImport = action === 'accept' || action === 'supersede';
    this.dataChangedReactCallback();
  }
}

export const MatchImportResultsModalContext = createContext<MatchImportResultsManager>(new MatchImportResultsManager());
