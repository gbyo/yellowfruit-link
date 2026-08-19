import { createContext } from 'react';
import MatchImportResult, { ImportResultStatus } from '../DataModel/MatchImportResult';
import { Round } from '../DataModel/Round';
import { StatsValidity } from '../DataModel/Match';
import { getFileNameFromPath } from '../Utils/GeneralUtils';
import Tournament from '../DataModel/Tournament';
import { Phase } from '../DataModel/Phase';

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
      if (MatchImportResultsManager.scheduledGameAlreadyPlayed(res)) continue;

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
}

export const MatchImportResultsModalContext = createContext<MatchImportResultsManager>(new MatchImportResultsManager());
