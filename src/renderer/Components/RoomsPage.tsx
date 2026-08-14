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
import { isValidQbtcpPort } from '../../qbtcp/QbtcpProtocol';
import { Round } from '../DataModel/Round';

function RoomsPage() {
  const tournManager = useContext(TournamentContext);
  const rooms = tournManager.roomsManager;
  const [, forceUpdate] = useState({});
  const [pairingSheetsOpen, setPairingSheetsOpen] = useState(false);

  useEffect(() => {
    rooms.dataChangedReactCallback = () => forceUpdate({});
    rooms.refresh();
    return () => {
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
  const assignmentLocked = !!room.session && !room.session.finalReceived;
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
          <ResultCell room={room} />
        </TableCell>
        <TableCell align="right">
          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
            <Button
              size="small"
              disabled={assignmentLocked}
              title={
                assignmentLocked ? 'Finish the current scoring session before changing the assignment.' : undefined
              }
              onClick={() => setAssignOpen(true)}
            >
              {room.assignment ? 'Change' : 'Assign'}
            </Button>
            {room.assignment && (
              <>
                <Button
                  size="small"
                  disabled={assignmentLocked}
                  title={
                    assignmentLocked ? 'Finish the current scoring session before clearing the assignment.' : undefined
                  }
                  onClick={() => rooms.clearAssignment(room.id)}
                >
                  Clear
                </Button>
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
            <Tooltip title="Remove room">
              <IconButton
                size="small"
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

/**
 * Whether a device is there, and what it is doing.
 *
 * "Stale" rather than "disconnected" when a room was connected and has gone quiet: presence is
 * advisory, and a missed heartbeat is not evidence that the room stopped scoring.
 */
function ConnectionCell(props: IRoomRowProps) {
  const { room } = props;
  if (!room.paired) return <Chip size="small" variant="outlined" label="Not paired" />;
  if (room.session?.finalReceived) return <Chip size="small" color="success" label="Final received" />;
  if (room.session?.scoring) {
    const label = room.session.tossupsRead !== undefined ? `Scoring · TU ${room.session.tossupsRead}` : 'Scoring';
    return <Chip size="small" color="primary" label={label} />;
  }
  if (room.connected) return <Chip size="small" color="success" variant="outlined" label="Connected" />;
  return <Chip size="small" variant="outlined" label={room.lastSeenAt ? 'Stale' : 'Waiting'} />;
}

function ResultCell(props: IRoomRowProps) {
  const { room } = props;
  if (!room.result) return <span>—</span>;
  switch (room.result.status) {
    case 'needs-review':
      return <Chip size="small" color="warning" label="Needs review" />;
    case 'accepted':
      return <Chip size="small" color="success" label="Accepted" />;
    case 'duplicate':
      return <Chip size="small" variant="outlined" label="Already recorded" />;
    case 'conflict':
      return <Chip size="small" color="error" label="Conflict" />;
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
 * Choose a round and two teams.
 *
 * Reads the tournament's own rounds and teams rather than keeping a schedule of its own. This page
 * adds no scheduling concepts to YellowFruit - it only names a game that the tournament already
 * describes.
 */
function AssignDialog(props: IAssignDialogProps) {
  const { room, isOpen, onClose } = props;
  const tournManager = useContext(TournamentContext);
  const rooms = tournManager.roomsManager;
  const { tournament } = tournManager;

  const allRounds: Round[] = tournament.phases.flatMap((phase) => phase.rounds);
  const teams = tournament.getListOfAllTeams();

  const [roundName, setRoundName] = useState(room.assignment ? String(room.assignment.roundNumber) : '');
  const [leftName, setLeftName] = useState(room.assignment?.leftTeamName ?? '');
  const [rightName, setRightName] = useState(room.assignment?.rightTeamName ?? '');

  const round = allRounds.find((entry) => String(entry.number) === roundName);
  const leftTeam = teams.find((team) => team.name === leftName);
  const rightTeam = teams.find((team) => team.name === rightName);
  const sameTeam = leftName !== '' && leftName === rightName;
  const canAssign = !!round && !!leftTeam && !!rightTeam && !sameTeam;

  return (
    <Dialog open={isOpen} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Assign a game to {room.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {allRounds.length === 0 && (
            <Alert severity="info">This tournament has no rounds yet. Set up the schedule first.</Alert>
          )}
          <TextField select size="small" label="Round" value={roundName} onChange={(e) => setRoundName(e.target.value)}>
            {allRounds.map((entry) => (
              <MenuItem key={entry.name} value={String(entry.number)}>
                {entry.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label="Team A" value={leftName} onChange={(e) => setLeftName(e.target.value)}>
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
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          disabled={!canAssign}
          onClick={() => {
            if (round && leftTeam && rightTeam) rooms.assign(room.id, round, leftTeam, rightTeam);
            onClose();
          }}
        >
          Assign
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RoomsPage;
