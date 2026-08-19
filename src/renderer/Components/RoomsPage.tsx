/**
 * The Rooms page: the whole user interface of the QBTCP adapter.
 *
 * Deliberately an ordinary YellowFruit page - the same cards, table and MUI styling as the rest of the
 * application, and no dashboard. A director needs four things here: whether the server is up and at
 * what address, what each room's pairing code is, what each room has been told to score, and whether a
 * result has come back. Everything else on this page would be something to read past during a round.
 *
 * Nothing here talks to the network. It reads a status object the main process assembled and sends
 * commands back; every failure arrives as text to display rather than as an exception. That is what
 * keeps a room going offline from being able to break the page a director is standing in front of.
 */
import { useContext, useEffect, useState } from 'react';
import Grid from '@mui/material/Unstable_Grid2';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Delete, Edit, FileDownload, PlayArrow, Refresh, Stop } from '@mui/icons-material';
import { TournamentContext } from '../TournamentManager';
import YfCard from './YfCard';
import PairingSheetsDialog from './PairingSheetsDialog';
import { IRoomView } from '../../qbtcp/QbtcpState';
import { isValidQbtcpPort, presenceFreshMs, qbtcpHelpCategoryLabels } from '../../qbtcp/QbtcpProtocol';
import { Round } from '../DataModel/Round';
import { LinkButton } from '../Utils/GeneralReactUtils';

/**
 * How often this page re-reads room status while it is open.
 *
 * A third of the presence window, so a room that stops sending heartbeats reads as stale within a
 * few seconds of actually being stale rather than a lapse later.
 */
const presenceRefreshMs = Math.round(presenceFreshMs / 3);

function RoomsPage() {
  const tournManager = useContext(TournamentContext);
  const rooms = tournManager.roomsManager;
  const [, forceUpdate] = useState({});
  const [pairingSheetsOpen, setPairingSheetsOpen] = useState(false);

  useEffect(() => {
    rooms.dataChangedReactCallback = () => forceUpdate({});
    rooms.refresh();
    // Presence expires on a clock, and a room that has gone quiet sends nothing to say so. Without a
    // tick of its own this page would keep a dead Chromebook on screen as "Scoring" until something
    // else happened to refresh it, which is the one moment a director needs the truth.
    const timer = setInterval(() => rooms.pollStatus(), presenceRefreshMs);
    return () => {
      clearInterval(timer);
      rooms.dataChangedReactCallback = () => {};
    };
  }, [rooms]);

  const { status } = rooms;

  return (
    <>
      <Grid container spacing={2}>
        {rooms.lastError && (
          <Grid xs={12}>
            <Alert severity="error">{rooms.lastError}</Alert>
          </Grid>
        )}
        <Grid xs={12}>
          <ServerCard />
        </Grid>
        <Grid xs={12}>
          <YfCard
            title="Rooms"
            secondaryHeader={
              <Stack direction="row" spacing={1}>
                <Tooltip title="Refresh room status">
                  <IconButton size="small" onClick={() => rooms.refresh()}>
                    <Refresh fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={status.rooms.length === 0}
                  onClick={() => setPairingSheetsOpen(true)}
                >
                  Print pairing sheets
                </Button>
                <Button size="small" variant="outlined" onClick={() => rooms.addRoom(nextRoomName(status.rooms))}>
                  Add room
                </Button>
              </Stack>
            }
          >
            {status.rooms.length === 0 ? (
              <Typography variant="body2">
                No rooms yet. Add one, then read its pairing code to the scorekeeper in that room.
              </Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Room</TableCell>
                    <TableCell>Pairing code</TableCell>
                    <TableCell>Connection</TableCell>
                    <TableCell>Assignment</TableCell>
                    <TableCell>Help</TableCell>
                    <TableCell>Result</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {status.rooms.map((room) => (
                    <RoomRow key={room.id} room={room} />
                  ))}
                </TableBody>
              </Table>
            )}
          </YfCard>
        </Grid>
      </Grid>
      <PairingSheetsDialog open={pairingSheetsOpen} onClose={() => setPairingSheetsOpen(false)} />
    </>
  );
}

/** "Room 1", "Room 2", ... skipping names already taken. */
function nextRoomName(existing: IRoomView[]): string {
  for (let n = 1; n <= existing.length + 1; n++) {
    const candidate = `Room ${n}`;
    if (!existing.some((room) => room.name === candidate)) return candidate;
  }
  return `Room ${existing.length + 1}`;
}

function ServerCard() {
  const tournManager = useContext(TournamentContext);
  const rooms = tournManager.roomsManager;
  const { status } = rooms;

  return (
    <YfCard
      title="QBTCP server"
      secondaryHeader={
        <Chip
          size="small"
          color={status.running ? 'success' : 'default'}
          label={status.running ? 'Running' : 'Stopped'}
        />
      }
    >
      <Stack spacing={2}>
        {status.error && <Alert severity="warning">{status.error}</Alert>}
        <Stack direction="row" spacing={2} alignItems="center">
          <TextField
            size="small"
            label="Port"
            type="number"
            sx={{ width: 120 }}
            disabled={status.running || rooms.busy}
            value={rooms.port}
            onChange={(e) => {
              const port = Number(e.target.value);
              if (isValidQbtcpPort(port)) rooms.setPort(port);
            }}
          />
          {status.running ? (
            <Button variant="outlined" startIcon={<Stop />} disabled={rooms.busy} onClick={() => rooms.stopServer()}>
              Stop server
            </Button>
          ) : (
            <Button
              variant="contained"
              startIcon={<PlayArrow />}
              disabled={rooms.busy}
              onClick={() => rooms.startServer()}
            >
              Start server
            </Button>
          )}
        </Stack>
        {status.running && (
          <div>
            <Typography variant="subtitle2">Addresses a scorekeeper can enter in QBSheet</Typography>
            {status.addresses.map((address) => (
              <Typography key={address} variant="body2" sx={{ fontFamily: 'monospace' }}>
                {address}
              </Typography>
            ))}
          </div>
        )}
        <Typography variant="body2" color="text.secondary">
          Starting this server does not change how YellowFruit works. Importing games from a file, saving, exporting,
          editing matches by hand and stat reports all behave exactly as they do with it stopped.
        </Typography>
      </Stack>
    </YfCard>
  );
}

interface IRoomRowProps {
  room: IRoomView;
}

function RoomRow(props: IRoomRowProps) {
  const { room } = props;
  const tournManager = useContext(TournamentContext);
  const rooms = tournManager.roomsManager;
  // A received final is not a settled game. Until the director has decided what to do with it, the
  // pairing it was scored against has to stay put, or the review ends up pointing at a game this
  // room is no longer playing. The main process refuses these commands for the same reason.
  const awaitingReview = room.result?.status === 'needs-review' || room.result?.status === 'conflict';
  const assignmentLocked = (!!room.session && !room.session.finalReceived) || awaitingReview;
  const lockReason = awaitingReview ? 'Review this room’s result' : 'Finish the current scoring session';
  const openHelpRequests = room.helpRequests ?? [];
  const removalLocked = assignmentLocked || openHelpRequests.length > 0;
  const removalLockReason =
    openHelpRequests.length > 0 ? 'Resolve this room’s help request' : `${lockReason} before removing the room`;
  const [assignOpen, setAssignOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(room.name);

  return (
    <>
      <TableRow>
        <TableCell>{room.name}</TableCell>
        <TableCell sx={{ fontFamily: 'monospace' }}>{room.pairingCode}</TableCell>
        <TableCell>
          <ConnectionCell room={room} />
        </TableCell>
        <TableCell>
          {room.assignment
            ? `Round ${room.assignment.roundNumber}: ${room.assignment.leftTeamName} vs ${room.assignment.rightTeamName}`
            : '—'}
        </TableCell>
        <TableCell>
          <HelpCell room={room} />
        </TableCell>
        <TableCell>
          <ResultCell room={room} />
        </TableCell>
        <TableCell align="right">
          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
            <Tooltip describeChild title={assignmentLocked ? `${lockReason} before changing the assignment.` : ''}>
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
              <span tabIndex={assignmentLocked ? 0 : undefined} style={{ display: 'inline-flex' }}>
                <Button size="small" disabled={assignmentLocked || rooms.busy} onClick={() => setAssignOpen(true)}>
                  {room.assignment ? 'Change' : 'Assign'}
                </Button>
              </span>
            </Tooltip>
            {room.assignment && (
              <>
                <Tooltip describeChild title={assignmentLocked ? `${lockReason} before clearing the assignment.` : ''}>
                  {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
                  <span tabIndex={assignmentLocked ? 0 : undefined} style={{ display: 'inline-flex' }}>
                    <Button
                      size="small"
                      disabled={assignmentLocked || rooms.busy}
                      onClick={() => rooms.clearAssignment(room.id)}
                    >
                      Clear
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Export this assignment as a .qbj file for offline scoring">
                  <IconButton
                    size="small"
                    onClick={() => {
                      rooms
                        .exportAssignment(room.id)
                        .then((exported) => {
                          if (exported) tournManager.makeToast('Assignment exported');
                          return undefined;
                        })
                        .catch(() => undefined);
                    }}
                  >
                    <FileDownload fontSize="small" />
                  </IconButton>
                </Tooltip>
              </>
            )}
            <Tooltip title="Rename room">
              <IconButton
                size="small"
                onClick={() => {
                  setNewName(room.name);
                  setRenaming(true);
                }}
              >
                <Edit fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip describeChild title={removalLocked ? `${removalLockReason}.` : 'Remove room'}>
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
              <span tabIndex={removalLocked ? 0 : undefined} style={{ display: 'inline-flex' }}>
                <IconButton
                  size="small"
                  aria-label="Remove room"
                  disabled={removalLocked || rooms.busy}
                  onClick={() =>
                    tournManager.genericModalManager.open(
                      'Remove Room',
                      `Are you sure you want to remove ${room.name}?`,
                      'N&o',
                      '&Yes',
                      () => rooms.removeRoom(room.id).catch(() => undefined),
                    )
                  }
                >
                  <Delete fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        </TableCell>
      </TableRow>

      {assignOpen && <AssignDialog room={room} isOpen onClose={() => setAssignOpen(false)} />}

      <Dialog open={renaming} onClose={() => setRenaming(false)}>
        <DialogTitle>Rename room</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            size="small"
            label="Room name"
            sx={{ mt: 1 }}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenaming(false)}>Cancel</Button>
          <Button
            onClick={() => {
              rooms.renameRoom(room.id, newName.trim() || room.name);
              setRenaming(false);
            }}
          >
            Rename
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function HelpCell(props: IRoomRowProps) {
  const { room } = props;
  const rooms = useContext(TournamentContext).roomsManager;
  const openHelpRequests = room.helpRequests ?? [];
  if (openHelpRequests.length === 0) return <span>—</span>;
  return (
    <Stack spacing={0.5} sx={{ minWidth: 220 }}>
      {openHelpRequests.map((request) => (
        <div key={request.id}>
          <Chip size="small" color="warning" label={qbtcpHelpCategoryLabels[request.category]} />
          {request.message && (
            <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
              {request.message}
            </Typography>
          )}
          <Button size="small" disabled={rooms.busy} onClick={() => rooms.resolveHelpRequest(request.id)}>
            Resolve
          </Button>
        </div>
      ))}
    </Stack>
  );
}

/**
 * Whether a device is there, and what it is doing.
 *
 * "Stale" rather than "disconnected" when a room was connected and has gone quiet: presence is
 * advisory, and a missed heartbeat is not evidence that the room stopped scoring.
 */
function ConnectionCell(props: IRoomRowProps) {
  const { room } = props;
  if (room.session?.finalReceived) return <Chip size="small" color="success" label="Final received" />;
  if (!room.paired) return <Chip size="small" variant="outlined" label="Not paired" />;
  if (!room.connected) {
    return <Chip size="small" variant="outlined" label={room.lastSeenAt ? 'Stale' : 'Waiting'} />;
  }
  if (room.session?.scoring) {
    const label = room.session.tossupsRead !== undefined ? `Scoring · TU ${room.session.tossupsRead}` : 'Scoring';
    return <Chip size="small" color="primary" label={label} />;
  }
  return <Chip size="small" color="success" variant="outlined" label="Connected" />;
}

function ResultCell(props: IRoomRowProps) {
  const { room } = props;
  const tournManager = useContext(TournamentContext);
  const { result } = room;
  if (!result) return <span>—</span>;
  switch (result.status) {
    case 'needs-review':
      return (
        <Chip
          size="small"
          color="warning"
          clickable
          label="Needs review · Review"
          title="Open result review"
          onClick={() => tournManager.reviewQbtcpResult(result.id)}
        />
      );
    case 'accepted':
      return <Chip size="small" color="success" label="Accepted" />;
    case 'duplicate':
      return <Chip size="small" variant="outlined" label="Already recorded" />;
    case 'conflict':
      return (
        <Chip
          size="small"
          color="error"
          clickable
          label="Conflict · Review"
          title="Open result review"
          onClick={() => tournManager.reviewQbtcpResult(result.id)}
        />
      );
    default:
      return <span>—</span>;
  }
}

interface IAssignDialogProps {
  room: IRoomView;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Choose which game this room will score.
 *
 * The normal path is picking an already-scheduled game: the tournament knows who plays whom, and the
 * director's job here is to say where. Selecting a pairing rather than retyping it is also what keeps
 * the room's assignment tied to a stable identity, so the result that comes back names the pairing it
 * was scored against instead of a game invented at the moment of assignment.
 *
 * Manual entry remains, one click away. Tiebreakers, oddly-shaped finals, a consolation bracket
 * playing arbitrary matchups, a legacy tournament with no schedule written, and the moment on a
 * tournament morning when something has to happen right now regardless of what the schedule says -
 * all of those need a round and two teams typed in, and none of them are unusual enough to be worth
 * making impossible.
 */
function AssignDialog(props: IAssignDialogProps) {
  const { room, isOpen, onClose } = props;
  const tournManager = useContext(TournamentContext);
  const rooms = tournManager.roomsManager;
  const { tournament } = tournManager;

  const allRounds: Round[] = tournament.phases.flatMap((phase) => phase.rounds);
  const teams = tournament.getListOfAllTeams();
  const eligible = rooms.eligibleScheduledGames(tournament, room.id);

  // Manual is the fallback, not the default - unless there is nothing scheduled to choose from, in
  // which case it is the only thing this dialog can usefully offer.
  const [manual, setManual] = useState(eligible.length === 0);
  const [scheduledGameId, setScheduledGameId] = useState(
    () => eligible.find((entry) => entry.game.id === room.assignment?.matchId)?.game.id ?? eligible[0]?.game.id ?? '',
  );
  const [roundName, setRoundName] = useState(room.assignment ? String(room.assignment.roundNumber) : '');
  const [leftName, setLeftName] = useState(room.assignment?.leftTeamName ?? '');
  const [rightName, setRightName] = useState(room.assignment?.rightTeamName ?? '');

  const chosenScheduled = eligible.find((entry) => entry.game.id === scheduledGameId);
  const round = allRounds.find((entry) => String(entry.number) === roundName);
  const leftTeam = teams.find((team) => team.name === leftName);
  const rightTeam = teams.find((team) => team.name === rightName);
  const sameTeam = leftName !== '' && leftName === rightName;
  const canAssign = manual ? !!round && !!leftTeam && !!rightTeam && !sameTeam : !!chosenScheduled;

  const handleAssign = () => {
    if (manual) {
      if (round && leftTeam && rightTeam) rooms.assign(room.id, round, leftTeam, rightTeam);
    } else if (chosenScheduled) {
      rooms.assignScheduledGame(room.id, chosenScheduled.round, chosenScheduled.game);
    }
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Assign a game to {room.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {!manual && eligible.length === 0 && (
            <Alert severity="info">
              No scheduled games are available. Generate or add pairings on the Schedule page, or assign a game
              manually.
            </Alert>
          )}
          {!manual && eligible.length > 0 && (
            <TextField
              select
              size="small"
              label="Scheduled game"
              value={scheduledGameId}
              onChange={(e) => setScheduledGameId(e.target.value)}
            >
              {eligible.map((entry) => (
                <MenuItem key={entry.game.id} value={entry.game.id}>
                  {`${entry.round.displayName()} \u00b7 ${entry.game.displayName()}`}
                </MenuItem>
              ))}
            </TextField>
          )}
          {manual && (
            <>
              {allRounds.length === 0 && (
                <Alert severity="info">This tournament has no rounds yet. Set up the schedule first.</Alert>
              )}
              <TextField
                select
                size="small"
                label="Round"
                value={roundName}
                onChange={(e) => setRoundName(e.target.value)}
              >
                {allRounds.map((entry) => (
                  <MenuItem key={entry.name} value={String(entry.number)}>
                    {entry.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                label="Team A"
                value={leftName}
                onChange={(e) => setLeftName(e.target.value)}
              >
                {teams.map((team) => (
                  <MenuItem key={team.id} value={team.name}>
                    {team.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                label="Team B"
                value={rightName}
                onChange={(e) => setRightName(e.target.value)}
              >
                {teams.map((team) => (
                  <MenuItem key={team.id} value={team.name}>
                    {team.name}
                  </MenuItem>
                ))}
              </TextField>
              {sameTeam && <Alert severity="warning">A team cannot play itself.</Alert>}
            </>
          )}
          <LinkButton sx={{ alignSelf: 'flex-start' }} onClick={() => setManual(!manual)}>
            {manual ? 'Choose a scheduled game instead' : 'Manual assignment'}
          </LinkButton>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={!canAssign} onClick={handleAssign}>
          Assign
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RoomsPage;
