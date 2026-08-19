import {
  Card,
  CardContent,
  ToggleButtonGroup,
  ToggleButton,
  Stack,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Typography,
  IconButton,
  Box,
  Tooltip,
  Divider,
  Autocomplete,
  TextField,
  Skeleton,
  Button,
  Chip,
} from '@mui/material';
import Grid from '@mui/material/Unstable_Grid2';
import React, { useContext, useMemo, useState } from 'react';
import { Add, Delete, Edit, Error, ExpandMore, FileUpload, FilterAlt, Warning } from '@mui/icons-material';
import { TournamentContext } from '../TournamentManager';
import useSubscription from '../Utils/CustomHooks';
import YfCard from './YfCard';
import { Match } from '../DataModel/Match';
import { Phase } from '../DataModel/Phase';
import { Round } from '../DataModel/Round';
import { ScheduledGame } from '../DataModel/ScheduledGame';
import GamesViewByPool from './GamesPagePoolView';
import { ValidationStatuses } from '../DataModel/Interfaces';
import { Team } from '../DataModel/Team';
import { CtrlOrCmd, trunc } from '../Utils/GeneralUtils';

// Defines the order the buttons should be in
const viewList = ['By Round', 'By Pool'];

const teamSelectNullOption = '';

export default function GamesPage() {
  const tournManager = useContext(TournamentContext);
  const [curView] = useSubscription(tournManager.currentGamesPageView);
  const [filterTeam, setFilterTeam] = useState<Team | undefined>(undefined);

  return (
    <>
      <Card sx={{ marginBottom: 2, '& .MuiCardContent-root': { paddingBottom: 2.1 } }}>
        <CardContent>
          <Grid container spacing={2}>
            <Grid xs="auto">
              <ToggleButtonGroup
                size="small"
                color="primary"
                exclusive
                value={curView}
                onChange={(e, newValue) => {
                  if (newValue === null) return;
                  tournManager.setGamesPageView(newValue);
                }}
              >
                {viewList.map((val, idx) => (
                  <ToggleButton key={val} value={idx}>
                    {val}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Grid>
            <Grid xs>
              <Tooltip placement="top" title={`Import games from one file into multiple rounds (${CtrlOrCmd()}+M)`}>
                <span>
                  <Button
                    sx={{ marginTop: '1px' }}
                    variant="outlined"
                    size="medium"
                    startIcon={<FileUpload />}
                    disabled={tournManager.tournament.phases.length === 0}
                    onClick={() => tournManager.launchImportMatchWorkflow()}
                  >
                    Import
                  </Button>
                </span>
              </Tooltip>
            </Grid>
            {curView === 0 && (
              <Grid xs={5}>
                <TeamFilterField filterByTeam={setFilterTeam} />
              </Grid>
            )}
          </Grid>
        </CardContent>
      </Card>
      {curView === 0 && <GamesViewByRound filterTeam={filterTeam} />}
      {curView === 1 && <GamesViewByPool />}
    </>
  );
}

interface ITeamFilterFieldProps {
  filterByTeam: (team: Team | undefined) => void;
}

function TeamFilterField(props: ITeamFilterFieldProps) {
  const { filterByTeam } = props;
  const tournManager = useContext(TournamentContext);
  const thisTourn = tournManager.tournament;
  const [filterTeam, setFilterTeam] = useState<Team | undefined>(undefined);
  const [filterInputValue, setFilterInputValue] = useState('');

  const handleFilterChange = (val: string | null) => {
    const matchingTeam = val === null ? undefined : thisTourn.findTeamByName(val) ?? undefined;
    setFilterTeam(matchingTeam);
    filterByTeam(matchingTeam);
  };

  const isOptionEqualToValue = (option: string, value: string) => {
    if (value === option) return true;
    return value === '' && option === teamSelectNullOption;
  };

  const allTeamNames = useMemo(() => thisTourn.getListOfAllTeams().map((tm) => tm.name), [thisTourn]);
  const filterOptions = [teamSelectNullOption].concat(allTeamNames);

  return (
    <Autocomplete
      autoHighlight
      clearOnEscape
      autoSelect
      value={filterTeam?.name ?? ''}
      onChange={(event: any, newValue: string | null) => handleFilterChange(newValue)}
      inputValue={filterInputValue}
      onInputChange={(event, newVal) => setFilterInputValue(newVal)}
      options={filterOptions}
      isOptionEqualToValue={isOptionEqualToValue}
      // eslint-disable-next-line react/jsx-props-no-spreading
      renderInput={(params) => <TextField {...params} size="small" label="Filter by team" />}
    />
  );
}

interface IGameViewByRoundProps {
  filterTeam: Team | undefined;
}

function GamesViewByRound(props: IGameViewByRoundProps) {
  const { filterTeam } = props;
  const tournManager = useContext(TournamentContext);
  const [phases] = useSubscription(tournManager.tournament.phases);

  return (
    <Stack spacing={2}>
      {phases.map((phase) => (
        <GamesForPhaseByRound key={phase.name} phase={phase} filterTeam={filterTeam} />
      ))}
    </Stack>
  );
}

interface IGamesForPhaseByRoundProps {
  phase: Phase;
  filterTeam: Team | undefined;
}

function GamesForPhaseByRound(props: IGamesForPhaseByRoundProps) {
  const { phase, filterTeam } = props;

  return (
    <YfCard title={phase.name}>
      {phase.rounds.map((round) => (
        <SingleRound
          key={round.name}
          round={round}
          expanded={!!filterTeam}
          forceNumericDisplay={phase.forceNumericRounds || false}
          filterTeam={filterTeam}
        />
      ))}
    </YfCard>
  );
}

interface ISingleRoundProps {
  round: Round;
  expanded: boolean;
  forceNumericDisplay: boolean;
  filterTeam: Team | undefined;
}

function SingleRound(props: ISingleRoundProps) {
  const { round, expanded: expandedProp, forceNumericDisplay, filterTeam } = props;
  const tournManager = useContext(TournamentContext);
  const [expanded, setExpanded] = useState(expandedProp);
  const canAddMatch = useMemo(() => tournManager.tournament.readyToAddMatches(), [tournManager]);
  const [numErrs, numWarns] = filterTeam === undefined ? round.countErrorsAndWarnings() : [0, 0];
  const [prevFilterTeam, setPrevFilterTeam] = useState<Team | undefined>(undefined);

  const matchesToShow = useMemo(
    () => (filterTeam ? round.matches.filter((m) => m.includesTeam(filterTeam)) : round.matches),
    [filterTeam, round.matches],
  );
  const numMatches = matchesToShow.length;
  // Pairings that have not been played yet. Shown separately and labelled, never mixed into the game
  // count: `numMatches` is the number of games that have actually been entered in this round, and
  // everything on this page that says "game" means one of those.
  const scheduledToShow = useMemo(
    () =>
      round.scheduledGames.filter(
        (sg) => !round.scheduledGameIsComplete(sg) && (!filterTeam || sg.includesTeam(filterTeam)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterTeam, round.scheduledGames, round.matches],
  );

  if (prevFilterTeam !== filterTeam) {
    // Scheduled games count towards opening the round: filtering by a team is asking "what does this
    // team have here", and what they have left to play is part of the answer.
    if (filterTeam && numMatches + scheduledToShow.length > 0) setExpanded(true);
    else setExpanded(false);
    setPrevFilterTeam(filterTeam);
  }

  const newMatchForRound = () => {
    tournManager.openMatchModalNewMatchForRound(round);
  };
  const importMatches = () => {
    tournManager.launchImportMatchWorkflow(round);
  };

  return (
    <Accordion
      expanded={expanded}
      elevation={expanded ? 4 : 1}
      sx={{
        '& .MuiAccordionSummary-content.Mui-expanded': { my: 0 },
        '& .MuiButtonBase-root-MuiAccordionSummary-root.Mui-expanded': { minHeight: '48px' },
      }}
      onChange={() => setExpanded(!expanded)}
    >
      <AccordionSummary expandIcon={<ExpandMore />}>
        <Typography sx={{ width: '33%', flexShrink: 0 }}>{round.displayName(forceNumericDisplay)}</Typography>
        <Typography sx={{ width: '34%', color: 'text.secondary' }}>
          {numMatches === 1 ? '1 game' : `${numMatches} games`}
          {scheduledToShow.length > 0 && ` \u00b7 ${scheduledToShow.length} scheduled`}
          {!!filterTeam && <FilterAlt fontSize="small" sx={{ verticalAlign: 'sub' }} />}
        </Typography>
        <Typography sx={{ width: '28%' }}>
          {numErrs > 0 && (
            <>
              <span>{numErrs}</span>
              <Tooltip title={roundValidationIconTooltip(numErrs, 'e')}>
                <Error color="error" sx={{ verticalAlign: 'text-bottom', marginTop: '-3px' }} />
              </Tooltip>
            </>
          )}
          {numWarns > 0 && (
            <>
              <span>{numWarns}</span>
              <Tooltip title={roundValidationIconTooltip(numWarns, 'w')}>
                <Warning color="warning" sx={{ verticalAlign: 'text-bottom', marginTop: '-3px' }} />
              </Tooltip>
            </>
          )}
        </Typography>
        {canAddMatch && (
          <>
            <Tooltip title="Enter a new game for this round" placement="left">
              <IconButton
                size="small"
                sx={{ p: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  newMatchForRound();
                }}
              >
                <Add />
              </IconButton>
            </Tooltip>
            <Tooltip
              placement="top-start"
              title="Import games from other files into this round"
              slotProps={{ popper: { modifiers: [{ name: 'offset', options: { offset: [0, 6] } }] } }}
            >
              <IconButton
                size="small"
                sx={{ p: 0 }}
                onClick={(e) => {
                  e.stopPropagation();
                  importMatches();
                }}
              >
                <FileUpload />
              </IconButton>
            </Tooltip>
          </>
        )}
      </AccordionSummary>
      <AccordionDetails>
        {expanded ? (
          <>
            <SingleRoundMatchList round={round} matchList={matchesToShow} />
            <ScheduledGameList scheduledGames={scheduledToShow} />
          </>
        ) : (
          <PlaceholderMatchList listSize={Math.min(matchesToShow.length + scheduledToShow.length, 6)} />
        )}
      </AccordionDetails>
    </Accordion>
  );
}

interface ISingleRoundMatchListProps {
  round: Round;
  matchList: Match[];
}

function SingleRoundMatchList(props: ISingleRoundMatchListProps) {
  const { round, matchList } = props;
  return (
    round.matches.length > 0 && (
      <Box sx={{ border: 1, borderRadius: 1, borderColor: 'lightgray' }}>
        {matchList.map((m, idx) => (
          <div key={m.id}>
            {idx !== 0 && <Divider />}
            <MatchListItem match={m} round={round} />
          </div>
        ))}
      </Box>
    )
  );
}

interface IScheduledGameListProps {
  scheduledGames: ScheduledGame[];
}

/**
 * The pairings in this round that nobody has entered a game for yet.
 *
 * Read-only and clearly marked. They are here because "what is left to play in this round" is the
 * question a director asks of this page during a tournament, and they are visually separate from the
 * matches above because a pairing is not a result - it has no score, no validation state and no
 * effect on the standings. The pairings themselves are edited on the Schedule page.
 */
function ScheduledGameList(props: IScheduledGameListProps) {
  const { scheduledGames } = props;
  if (scheduledGames.length === 0) return null;

  return (
    <Box sx={{ mt: 1, border: 1, borderRadius: 1, borderColor: 'lightgray', borderStyle: 'dashed' }}>
      {scheduledGames.map((game, idx) => (
        <div key={game.id}>
          {idx !== 0 && <Divider />}
          <Grid container sx={{ p: 1 }}>
            <Grid xs={8}>
              <Typography variant="body1" color="text.secondary">
                {game.displayName()}
              </Typography>
            </Grid>
            <Grid xs={4}>
              <Box sx={{ float: 'right' }}>
                <Chip size="small" variant="outlined" label="Scheduled" />
              </Box>
            </Grid>
          </Grid>
        </div>
      ))}
    </Box>
  );
}

interface IPlaceholderMatchListProps {
  listSize: number;
}

function PlaceholderMatchList(props: IPlaceholderMatchListProps) {
  const { listSize } = props;
  if (listSize === 0) return null;

  const placeholders: React.JSX.Element[] = [];
  for (let i = 1; i <= listSize; i++) {
    const widthPct = 15 + 35 * Math.random();
    placeholders.push(
      <Skeleton key={i} variant="text" width={`${widthPct.toPrecision(2)}%`} sx={{ fontSize: '16pt' }} />,
    );
  }

  return <Stack spacing={2}>{placeholders}</Stack>;
}

interface IMatchListItemProps {
  match: Match;
  round: Round;
}

function MatchListItem(props: IMatchListItemProps) {
  const { match, round } = props;
  const tournManager = useContext(TournamentContext);
  const validationStatus = match.getOverallValidationStatus();

  return (
    <Grid
      container
      sx={{ p: 1, '&:hover': { backgroundColor: 'ivory' } }}
      onDoubleClick={() => tournManager.openMatchEditModalExistingMatch(match, round)}
    >
      <Grid xs={8}>
        <Box typography="h6">{match.getScoreString()}</Box>
        <Typography variant="body2">
          {match.carryoverPhases.length > 0 && `Carries over to: ${match.listCarryoverPhases()}`}
        </Typography>
        {match.importedFile && <Typography variant="body2">{`Imported from ${match.importedFile}`}</Typography>}
        {match.notes && (
          <Typography variant="body2" color="gray">
            {match.notes}
          </Typography>
        )}
      </Grid>
      <Grid xs={2}>
        {validationStatus === ValidationStatuses.Error && (
          <Tooltip
            title={`This game has errors that prevent it from counting in the stat report: ${trunc(
              match.getErrorMessages().join('; '),
              120,
            )}`}
          >
            <Error color="error" sx={{ verticalAlign: 'text-bottom', marginTop: 1 }} />
          </Tooltip>
        )}
        {validationStatus === ValidationStatuses.Warning && (
          <Tooltip title={`This game has validation warnings: ${trunc(match.getWarningMessages().join('; '), 120)}`}>
            <Warning color="warning" sx={{ verticalAlign: 'text-bottom', marginTop: 1 }} />
          </Tooltip>
        )}
      </Grid>
      <Grid xs={2}>
        <Box sx={{ float: 'right' }}>
          <Tooltip title="Edit game">
            <IconButton onClick={() => tournManager.openMatchEditModalExistingMatch(match, round)}>
              <Edit />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete game">
            <IconButton onClick={() => tournManager.tryDeleteMatch(match, round)}>
              <Delete />
            </IconButton>
          </Tooltip>
        </Box>
      </Grid>
    </Grid>
  );
}

function roundValidationIconTooltip(num: number, errOrWarn: 'e' | 'w') {
  const start = num === 1 ? 'game has' : 'games have';
  const noun = errOrWarn === 'e' ? 'errors' : 'warnings';
  const msg = `${num} ${start} ${noun}`;
  if (errOrWarn === 'w') return msg;

  return `${msg}. Games with errors don't count in the stat report until the errors are corrected.`;
}
