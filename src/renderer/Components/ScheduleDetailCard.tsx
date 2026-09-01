import { useContext, useState } from 'react';
import Grid from '@mui/material/Unstable_Grid2';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Radio,
  RadioGroup,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add,
  ArrowDownward,
  ArrowUpward,
  Delete,
  Edit,
  ExpandMore,
  LockOpen,
  Shuffle,
  Tune,
} from '@mui/icons-material';
import { TournamentContext } from '../TournamentManager';
import YfCard from './YfCard';
import useSubscription from '../Utils/CustomHooks';
import { Phase, PhaseTypes, WildCardRankingMethod } from '../DataModel/Phase';
import { Pool, advOpportunityDisplay } from '../DataModel/Pool';
import { LinkButton } from '../Utils/GeneralReactUtils';
import { Round } from '../DataModel/Round';
import { ScheduledGame } from '../DataModel/ScheduledGame';
import { phaseCanGeneratePairings } from '../DataModel/PairingGeneration';
import RoundProcedureDialog from './RoundProcedureDialog';

const cardTitle = 'Schedule Detail';
const unlockCustSchedTooltip =
  'Add, remove, or modify stages and pools. Seeding and rebracketing assistance is not available for custom schedules.';
const usingCustSchedTooltip = 'Using a custom schedule. Seeding and rebracketing assistance are not available.';

export default function ScheduleDetailCard() {
  const tournManager = useContext(TournamentContext);
  const thisTournament = tournManager.tournament;
  const [phases] = useSubscription(thisTournament.phases);
  const [usingTemplate] = useSubscription(thisTournament.usingScheduleTemplate);

  if (thisTournament.phases.length === 0) {
    return (
      <YfCard title={cardTitle}>
        <ScheduleZeroState />
      </YfCard>
    );
  }

  const tooltip = usingTemplate ? unlockCustSchedTooltip : usingCustSchedTooltip;

  return (
    <YfCard
      title={cardTitle}
      secondaryHeader={
        <Tooltip title={tooltip}>
          <span>
            <Button
              variant="contained"
              disabled={!usingTemplate}
              onClick={() => tournManager.tryUnlockCustomSchedule()}
              startIcon={<LockOpen />}
            >
              {usingTemplate ? 'Customize' : 'Custom'}
            </Button>
          </span>
        </Tooltip>
      }
    >
      <List>
        {phases.map((phase) => (
          <Accordion key={`${phase.code}${phase.name}`} defaultExpanded>
            <PhaseAccordionHeader phase={phase} />
            <AccordionDetails>
              {phase.isFullPhase() ? <PhaseEditor phase={phase} /> : <MinorPhaseSection phase={phase} />}
            </AccordionDetails>
          </Accordion>
        ))}
      </List>
      {!usingTemplate && (
        <Tooltip title="Add a stage of pool-based play">
          <Button
            sx={{ marginTop: 1 }}
            variant="contained"
            onClick={() => tournManager.addPlayoffPhase()}
            startIcon={<Add />}
          >
            Add Playoff Stage
          </Button>
        </Tooltip>
      )}
    </YfCard>
  );
}

interface PhaseAccordionHeaderProps {
  phase: Phase;
}

function PhaseAccordionHeader(props: PhaseAccordionHeaderProps) {
  const { phase } = props;
  const tournManager = useContext(TournamentContext);
  const thisTourn = tournManager.tournament;
  const matchesExist = phase.anyMatchesExist();
  const [usingTemplate] = useSubscription(thisTourn.usingScheduleTemplate);

  const showDeleteButton = !phase.isFullPhase() || (!usingTemplate && phase.phaseType !== PhaseTypes.Prelim);
  const canMoveUp = thisTourn.canMovePhaseUp(phase);
  const canMoveDown = thisTourn.canMovePhaseDown(phase);

  return (
    <AccordionSummary
      expandIcon={<ExpandMore />}
      sx={{
        '& .MuiAccordionSummary-content': { justifyContent: 'space-between' },
        '& .MuiIconButton-root': { py: 0, px: 0.5, mx: 1 },
      }}
    >
      <div>
        <PhaseTitle phase={phase} />
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            tournManager.openPhaseModal(phase);
          }}
        >
          <Edit />
        </IconButton>
      </div>
      <div>
        {(canMoveUp || canMoveDown) && (
          <>
            <Tooltip title="Move up">
              <span>
                <IconButton
                  size="small"
                  disabled={!canMoveUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    tournManager.movePhaseUp(phase);
                  }}
                >
                  <ArrowUpward />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Move down">
              <span>
                <IconButton
                  size="small"
                  disabled={!canMoveDown}
                  onClick={(e) => {
                    e.stopPropagation();
                    tournManager.movePhaseDown(phase);
                  }}
                >
                  <ArrowDownward />
                </IconButton>
              </span>
            </Tooltip>
          </>
        )}
        {showDeleteButton && (
          <Tooltip title="Delete stage">
            <span>
              <IconButton
                size="small"
                disabled={matchesExist}
                onClick={(e) => {
                  e.stopPropagation();
                  tournManager.tryDeletePhase(phase);
                }}
              >
                <Delete />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </div>
    </AccordionSummary>
  );
}

interface IPhaseTitleProps {
  phase: Phase;
}

function PhaseTitle(props: IPhaseTitleProps) {
  const { phase } = props;
  const [phaseName] = useSubscription(phase.name);

  return (
    <>
      {phase.phaseType === PhaseTypes.Finals ? '' : `${phase.code}. `}
      {phaseName}&nbsp;
      {phaseRoundDisplay(phase)}
    </>
  );
}

interface IPhaseEditorProps {
  phase: Phase;
}

function PhaseEditor(props: IPhaseEditorProps) {
  const { phase } = props;
  const [selectedPoolIdx, setSelectedPoolIdx] = useState(0);
  const [wcRankValue, setWcRankValue] = useSubscription(phase.wildCardRankingMethod);

  const tournManager = useContext(TournamentContext);
  const thisTournament = tournManager.tournament;
  const selectedPool = phase.pools[selectedPoolIdx];
  const wcRules = phase.wildCardAdvancementRules;
  const showTiers = phase.phaseType === PhaseTypes.Playoff && thisTournament.usingScheduleTemplate;
  const canAddTB = !thisTournament.hasTiebreakerAfter(phase);
  const canAddFinals = thisTournament.isLastFullPhase(phase);
  const [usingTemplate] = useSubscription(thisTournament.usingScheduleTemplate);
  const dragKey = `pools-${phase.name}`;

  if (phase.pools === undefined) {
    return <span>Pools object is undefined for this phase</span>;
  }

  const handleWcRankMethodChange = (val: WildCardRankingMethod) => {
    setWcRankValue(val);
    tournManager.setPhaseWCRankMethod(phase, val);
  };
  const thenPPB = thisTournament.scoringRules.useBonuses ? ', then PPB' : '';

  return (
    <Grid container spacing={2}>
      {wcRules.length > 0 && phase.pools.length > 1 && (
        <Grid xs={12} sx={{ '& .MuiFormControlLabel-label': { typography: 'body2' }, '& .MuiRadio-root': { py: 0.5 } }}>
          <FormControl>
            <FormLabel>Cross-Pool (Wild Card) Ranking Method</FormLabel>
            <RadioGroup
              value={wcRankValue}
              onChange={(e) => handleWcRankMethodChange(e.target.value as WildCardRankingMethod)}
            >
              <FormControlLabel
                value={WildCardRankingMethod.RankThenPPB}
                control={<Radio size="small" />}
                label={`Rank within pool${thenPPB}`}
              />
              <FormControlLabel
                value={WildCardRankingMethod.RecordThanPPB}
                control={<Radio size="small" />}
                label={`Record${thenPPB}`}
              />
            </RadioGroup>
          </FormControl>
        </Grid>
      )}
      <Grid xs={5}>
        <Box
          sx={{
            marginTop: 1,
            border: 1,
            borderRadius: 1,
            borderColor: 'lightgray',
            '& .MuiListItem-root': { p: 0 },
            '& .MuiSvgIcon-root': { fontSize: '1.2rem' },
          }}
        >
          <List dense sx={{ py: 0 }}>
            {phase.pools.map((pool, idx) => (
              <div key={pool.name}>
                {idx !== 0 && <Divider />}
                <ListItem
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(dragKey, idx.toString())}
                  onDragEnter={(e) => e.preventDefault()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    tournManager.reorderPools(phase, e.dataTransfer.getData(dragKey), idx);
                  }}
                  onDragLeave={(e) => e.preventDefault()}
                  disableGutters
                  secondaryAction={
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        tournManager.openPoolModal(phase, pool);
                      }}
                    >
                      <Edit />
                    </IconButton>
                  }
                >
                  <ListItemButton selected={idx === selectedPoolIdx} onClick={() => setSelectedPoolIdx(idx)}>
                    <ListItemText
                      primary={pool.name}
                      secondary={`${showTiers ? `Tier ${pool.position} | ` : ''}${pool.size} Teams`}
                    />
                  </ListItemButton>
                </ListItem>
              </div>
            ))}
          </List>
        </Box>
      </Grid>
      <Grid xs={7}>
        <Typography sx={{ marginTop: 1 }} variant="subtitle2">
          {selectedPool?.name}
        </Typography>
        {selectedPool && <PoolDetail selectedPool={selectedPool} hasWildCardAdvancement={wcRules.length > 0} />}
      </Grid>
      <Grid xs={12}>
        <PhasePairingsSection phase={phase} />
      </Grid>
      <Grid xs>
        {!usingTemplate && (
          <Button size="small" variant="outlined" startIcon={<Add />} onClick={() => tournManager.addPool(phase)}>
            Add Pool
          </Button>
        )}
      </Grid>
      <Grid xs="auto">
        {canAddTB && (
          <LinkButton onClick={() => tournManager.addTiebreakerAfter(phase)}>
            <Add fontSize="small" />
            Add tiebreaker stage
          </LinkButton>
        )}
        <br />
        {canAddFinals && (
          <LinkButton onClick={() => tournManager.addFinalsPhase()}>
            <Add fontSize="small" />
            Add finals stage
          </LinkButton>
        )}
      </Grid>
    </Grid>
  );
}

interface IPoolDetailProps {
  selectedPool: Pool;
  hasWildCardAdvancement: boolean;
}

function PoolDetail(props: IPoolDetailProps) {
  const { selectedPool, hasWildCardAdvancement } = props;

  return (
    <Box typography="body2">
      <List dense>
        <ListItem disableGutters>{roundRobinDisplay(selectedPool)}</ListItem>
        {selectedPool.seeds.length > 0 && <ListItem disableGutters>Seeds {selectedPool.seeds.join(', ')}</ListItem>}
        {selectedPool.autoAdvanceRules.length > 0 && (
          <>
            <ListItem disableGutters>Advancement:</ListItem>
            {selectedPool.autoAdvanceRules.map((ao) => (
              <ListItem key={ao.tier}>{advOpportunityDisplay(ao)}</ListItem>
            ))}
            {hasWildCardAdvancement && <ListItem>Other ranks advance based on cross-pool ranking method</ListItem>}
          </>
        )}
      </List>
    </Box>
  );
}

interface IMinorPhaseSectionProps {
  phase: Phase;
}

/** A minimal section for a tiebreaker or finals phase */
function MinorPhaseSection(props: IMinorPhaseSectionProps) {
  const { phase } = props;
  const tournManager = useContext(TournamentContext);
  const [usesNumeric, setUsesNumeric] = useSubscription(phase.forceNumericRounds || false);

  const handleUsesNumericChange = (checked: boolean) => {
    setUsesNumeric(checked);
    if (checked) {
      tournManager.forcePhaseToBeNumeric(phase);
    } else {
      tournManager.undoForcePhaseToBeNumeric(phase);
    }
  };

  return (
    <FormGroup>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={usesNumeric}
            disabled={phase.preventConvertToNonNumericRounds()}
            onChange={(e) => handleUsesNumericChange(e.target.checked)}
          />
        }
        label="Uses numeric round"
        sx={{ width: 'fit-content' }}
      />
    </FormGroup>
  );
}

function ScheduleZeroState() {
  const tournManager = useContext(TournamentContext);

  return (
    <Grid container>
      <Grid xs />
      <Grid xs="auto">
        <Box sx={{ py: 13 }}>
          <div>
            <Typography variant="body2" sx={{ marginBottom: 1 }}>
              Choose a template to get started
            </Typography>
          </div>
          <div>
            <LinkButton onClick={() => tournManager.startNewCustomSchedule()}>
              <Tune fontSize="small" /> Create a custom schedule instead
            </LinkButton>
          </div>
        </Box>
      </Grid>
      <Grid xs />
    </Grid>
  );
}

interface IPhasePairingsSectionProps {
  phase: Phase;
}

/**
 * The pairings for one stage, by round.
 *
 * Deliberately small. This is a list of who plays whom, not a scheduling application: a director
 * needs to read the round off it, correct a pairing, and generate the round robin their pools imply.
 * Anything more elaborate here would compete with the Rooms page, which is where a pairing is
 * actually put to use.
 *
 * Collapsed by default, because a schedule template fills this in correctly and the common case is
 * having no reason to look.
 */
function PhasePairingsSection(props: IPhasePairingsSectionProps) {
  const { phase } = props;
  const tournManager = useContext(TournamentContext);
  const scheduledGames = phase.getAllScheduledGames();
  const canGenerate = phaseCanGeneratePairings(phase);
  const totalCompleted = phase.rounds.reduce((sum, rd) => sum + rd.countCompletedScheduledGames(), 0);

  return (
    <Accordion disableGutters sx={{ '&:before': { display: 'none' } }}>
      <AccordionSummary expandIcon={<ExpandMore />}>
        <Typography variant="subtitle2">Pairings</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ ml: 1 }}>
          {pairingSummary(scheduledGames.length, totalCompleted)}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1}>
          {canGenerate && (
            <Box>
              <Tooltip title="Create a round robin for each pool in this stage, using the teams currently assigned to it">
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<Shuffle />}
                  onClick={() => tournManager.tryGeneratePairings(phase)}
                >
                  Generate round-robin pairings
                </Button>
              </Tooltip>
            </Box>
          )}
          {phase.rounds.map((round) => (
            <RoundPairings key={round.number} phase={phase} round={round} />
          ))}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

interface IRoundPairingsProps {
  phase: Phase;
  round: Round;
}

function RoundPairings(props: IRoundPairingsProps) {
  const { phase, round } = props;
  const tournManager = useContext(TournamentContext);
  const { scheduledGames } = round;
  const [procedureOpen, setProcedureOpen] = useState(false);
  const procedureSummary = round.roomProcedure ? 'Custom room procedure' : 'Tournament defaults';
  const handoffSummary = round.handoffInstruction ? ' · Custom handoff' : '';

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" sx={{ fontWeight: 'medium' }}>
          {round.displayName()}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {pairingSummary(scheduledGames.length, round.countCompletedScheduledGames())}
        </Typography>
        <Tooltip title={`${procedureSummary}${handoffSummary}`}>
          <span>
            <IconButton
              size="small"
              aria-label={`Edit ${round.displayName()} room procedure`}
              onClick={() => setProcedureOpen(true)}
            >
              <Tune fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Add a pairing to this round">
          <IconButton size="small" onClick={() => tournManager.openScheduledGameModal(phase, round)}>
            <Add fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      {scheduledGames.length > 0 && (
        <List dense sx={{ py: 0, '& .MuiListItem-root': { py: 0 } }}>
          {scheduledGames.map((game) => (
            <ScheduledGameListItem key={game.id} phase={phase} round={round} game={game} />
          ))}
        </List>
      )}
      {procedureOpen && <RoundProcedureDialog round={round} open onClose={() => setProcedureOpen(false)} />}
    </Box>
  );
}

interface IScheduledGameListItemProps {
  phase: Phase;
  round: Round;
  game: ScheduledGame;
}

function ScheduledGameListItem(props: IScheduledGameListItemProps) {
  const { phase, round, game } = props;
  const tournManager = useContext(TournamentContext);
  // One answer, from the model, for whether this pairing may be touched: played games and games a
  // room is scoring are read-only here, and the Rooms page uses the same rule.
  const lockReason = tournManager.scheduledGameLockReason(game, round);
  const isPlayed = round.scheduledGameIsComplete(game);

  return (
    <ListItem
      disableGutters
      secondaryAction={
        <Stack direction="row" spacing={0}>
          <Tooltip title={lockReason ? `Can't edit: ${lockReason}` : 'Edit pairing'}>
            <span>
              <IconButton
                size="small"
                disabled={!!lockReason}
                onClick={() => tournManager.openScheduledGameModal(phase, round, game)}
              >
                <Edit fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={lockReason ? `Can't delete: ${lockReason}` : 'Delete pairing'}>
            <span>
              <IconButton
                size="small"
                disabled={!!lockReason}
                onClick={() => tournManager.tryDeleteScheduledGame(round, game)}
              >
                <Delete fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      }
    >
      <ListItemText
        primary={game.displayName()}
        secondary={
          isPlayed ? (
            <Chip size="small" color="success" variant="outlined" label="Played" />
          ) : (
            lockReason && <Chip size="small" color="primary" variant="outlined" label={lockReason} />
          )
        }
      />
    </ListItem>
  );
}

/** "2 scheduled - 1 completed", or "No pairings yet". */
function pairingSummary(numScheduled: number, numCompleted: number) {
  if (numScheduled === 0) return 'No pairings yet';
  if (numCompleted === 0) return `${numScheduled} scheduled`;
  if (numCompleted === numScheduled) return `${numCompleted} completed`;
  return `${numScheduled} scheduled \u00b7 ${numCompleted} completed`;
}

function phaseRoundDisplay(phase: Phase) {
  const { rounds } = phase;
  if (rounds.length === 0) return '';
  if (!phase.usesNumericRounds()) return '';
  if (rounds.length === 1) return `(Round ${rounds[0].number})`;

  return `(Rounds ${rounds[0].number} to ${rounds[rounds.length - 1].number})`;
}

function roundRobinDisplay(pool: Pool) {
  if (pool.roundRobins < 1) return 'Not a full round robin';
  return `${pool.roundRobins}x round robin${pool.hasCarryover ? ' with carryover' : ''}`;
}
