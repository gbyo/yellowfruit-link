import { useContext, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { TournamentContext } from '../TournamentManager';
import { IRoomView } from '../../qbtcp/QbtcpState';
import { defaultScoresheetUrl, normalizeScoresheetUrl } from '../../qbtcp/PairingLaunch';
import { buildPairingSheetsHtml, SheetsPerPage } from '../Utils/PairingSheets';

interface IPairingSheetsDialogProps {
  open: boolean;
  onClose: () => void;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isLoopbackAddress(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function firstNonLoopbackAddress(addresses: string[]): string {
  return addresses.find((address) => !isLoopbackAddress(address)) ?? addresses[0] ?? '';
}

export default function PairingSheetsDialog(props: IPairingSheetsDialogProps) {
  const { open, onClose } = props;
  const tournManager = useContext(TournamentContext);
  const { roomsManager } = tournManager;
  const { status } = roomsManager;
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [serverAddress, setServerAddress] = useState('');
  const [scoresheetUrl, setScoresheetUrl] = useState(defaultScoresheetUrl);
  const [perPage, setPerPage] = useState<SheetsPerPage>(4);
  const [printing, setPrinting] = useState(false);
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setSelectedRoomIds(status.rooms.map((room) => room.id));
    setServerAddress(firstNonLoopbackAddress(status.addresses));
    setScoresheetUrl(status.scoresheetUrl || defaultScoresheetUrl);
    setPerPage(4);
    setPrinting(false);
    setFormError(undefined);
    // Initialize from the status snapshot at the moment the dialog opens. Refreshes while the
    // director is editing must not overwrite their address or URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedRooms = status.rooms.filter((room) => selectedRoomIds.includes(room.id));
  const addressValid = isHttpUrl(serverAddress);
  const normalizedScoresheetUrl = normalizeScoresheetUrl(scoresheetUrl);
  const scoresheetUrlValid = normalizedScoresheetUrl !== undefined;
  const previewRoom = selectedRooms[0];

  const previewHtml = useMemo(() => {
    if (!previewRoom || !addressValid || !normalizedScoresheetUrl) return '';
    try {
      return buildPairingSheetsHtml({
        tournamentName: tournManager.tournament.name || 'YellowFruit tournament',
        serverAddress: serverAddress.trim(),
        scoresheetUrl: normalizedScoresheetUrl,
        rooms: [toPairingSheetRoom(previewRoom)],
        perPage: 1,
      });
    } catch {
      return '';
    }
  }, [addressValid, normalizedScoresheetUrl, previewRoom, serverAddress, tournManager.tournament.name]);

  const canPrint = selectedRooms.length > 0 && addressValid && scoresheetUrlValid && !printing && !roomsManager.busy;

  const handlePrint = async () => {
    if (!canPrint || !normalizedScoresheetUrl) return;
    setPrinting(true);
    setFormError(undefined);
    try {
      const html = buildPairingSheetsHtml({
        tournamentName: tournManager.tournament.name || 'YellowFruit tournament',
        serverAddress: serverAddress.trim(),
        scoresheetUrl: normalizedScoresheetUrl,
        rooms: selectedRooms.map(toPairingSheetRoom),
        perPage,
      });
      const saved = await roomsManager.setScoresheetUrl(normalizedScoresheetUrl);
      const printed = saved && (await roomsManager.printPairingSheets(html));
      if (printed) {
        tournManager.makeToast('Pairing sheets opened for printing');
        onClose();
      } else {
        setFormError(roomsManager.lastError ?? 'The pairing sheets could not be opened for printing.');
      }
    } catch (error) {
      setFormError((error as Error).message || 'The pairing sheets could not be prepared for printing.');
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Print pairing sheets</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Give each room its sheet. The QR code opens QBSheet with this room&apos;s server address and pairing code.
          </Typography>

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Rooms
            </Typography>
            <FormGroup>
              {status.rooms.map((room) => (
                <FormControlLabel
                  key={room.id}
                  control={
                    <Checkbox
                      checked={selectedRoomIds.includes(room.id)}
                      onChange={() =>
                        setSelectedRoomIds((current) =>
                          current.includes(room.id) ? current.filter((id) => id !== room.id) : [...current, room.id],
                        )
                      }
                    />
                  }
                  label={room.name}
                />
              ))}
            </FormGroup>
          </Box>

          <Box>
            <TextField
              fullWidth
              size="small"
              label="QBTCP server address"
              value={serverAddress}
              error={serverAddress !== '' && !addressValid}
              helperText={
                serverAddress !== '' && !addressValid
                  ? 'Enter an http:// or https:// address.'
                  : 'This is the address the scorekeeper will use to reach this computer.'
              }
              onChange={(event) => setServerAddress(event.target.value)}
            />
            {status.addresses.length > 0 && (
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                {status.addresses.map((address) => (
                  <Chip
                    key={address}
                    size="small"
                    clickable
                    variant={serverAddress === address ? 'filled' : 'outlined'}
                    label={address}
                    onClick={() => setServerAddress(address)}
                  />
                ))}
              </Stack>
            )}
            {!status.running && (
              <Alert severity="warning" sx={{ mt: 1 }}>
                The QBTCP server is stopped. You can prepare the sheets now, but this address must match the
                server&apos;s actual address when it starts.
              </Alert>
            )}
          </Box>

          <TextField
            fullWidth
            size="small"
            label="Scoresheet address"
            value={scoresheetUrl}
            error={scoresheetUrl !== '' && !scoresheetUrlValid}
            helperText={
              scoresheetUrl !== '' && !scoresheetUrlValid
                ? 'Enter an http:// or https:// address.'
                : 'This address is remembered for the next set of pairing sheets.'
            }
            onChange={(event) => setScoresheetUrl(event.target.value)}
          />

          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="subtitle2">Sheets per page</Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={perPage}
              onChange={(_event, value: SheetsPerPage | null) => {
                if (value !== null) setPerPage(value);
              }}
            >
              <ToggleButton value={1}>1</ToggleButton>
              <ToggleButton value={2}>2</ToggleButton>
              <ToggleButton value={4}>4</ToggleButton>
            </ToggleButtonGroup>
          </Stack>

          {formError && <Alert severity="error">{formError}</Alert>}

          <Box>
            <Typography variant="subtitle2" gutterBottom>
              Preview{previewRoom ? ` · ${previewRoom.name}` : ''}
            </Typography>
            <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', minHeight: 260 }}>
              {previewHtml ? (
                <iframe
                  title="Pairing sheet preview"
                  srcDoc={previewHtml}
                  sandbox=""
                  style={{ display: 'block', width: '100%', height: 360, border: 0 }}
                />
              ) : (
                <Alert severity="info" sx={{ m: 2 }}>
                  Select a room and enter valid HTTP(S) addresses to preview a pairing sheet.
                </Alert>
              )}
            </Box>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!canPrint} onClick={() => handlePrint()}>
          {printing ? 'Opening…' : 'Print'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function toPairingSheetRoom(room: IRoomView) {
  return { name: room.name, pairingCode: room.pairingCode, roomId: room.id };
}
