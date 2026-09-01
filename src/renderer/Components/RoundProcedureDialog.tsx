import { useContext, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { TournamentContext } from '../TournamentManager';
import { Round } from '../DataModel/Round';
import {
  cloneRoomProcedure,
  IRoomProcedure,
  normalizeHandoffInstruction,
  normalizeRoomProcedure,
} from '../DataModel/RoomProcedure';
import RoomProcedureFields from './RoomProcedureFields';

interface IRoundProcedureDialogProps {
  round: Round;
  open: boolean;
  onClose: () => void;
}

function RoundProcedureDialog(props: IRoundProcedureDialogProps) {
  const { round, open, onClose } = props;
  const tournManager = useContext(TournamentContext);
  const tournamentProcedure = tournManager.tournament.roomProcedure;
  const [customizeProcedure, setCustomizeProcedure] = useState(round.roomProcedure !== undefined);
  const [procedure, setProcedure] = useState<IRoomProcedure>(() =>
    cloneRoomProcedure(round.roomProcedure ?? tournamentProcedure),
  );
  const [customizeHandoff, setCustomizeHandoff] = useState(round.handoffInstruction !== undefined);
  const [handoffInstruction, setHandoffInstruction] = useState(
    round.handoffInstruction ?? tournManager.tournament.handoffInstruction ?? '',
  );
  const receivedResults = round.scheduledGames.filter((game) =>
    tournManager.roomsManager.hasReceivedResultForScheduledGame(game.id),
  ).length;

  const save = () => {
    round.roomProcedure = customizeProcedure ? normalizeRoomProcedure(procedure) : undefined;
    round.handoffInstruction = customizeHandoff ? normalizeHandoffInstruction(handoffInstruction) : undefined;
    tournManager.dataChangedReactCallback();
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{round.displayName()} room procedure</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Use the tournament defaults for this round, or save a complete round-specific procedure snapshot.
          </Typography>
          {receivedResults > 0 && (
            <Alert severity="warning">
              {receivedResults === 1 ? 'One game in this round has' : `${receivedResults} games in this round have`}{' '}
              already been issued to a room or returned a result. Existing assignments keep the procedure they were
              given; this change applies to future assignments.
            </Alert>
          )}
          <FormControlLabel
            control={
              <Checkbox
                checked={customizeProcedure}
                onChange={(event) => {
                  setCustomizeProcedure(event.target.checked);
                  if (event.target.checked)
                    setProcedure(cloneRoomProcedure(round.roomProcedure ?? tournamentProcedure));
                }}
              />
            }
            label="Customize room procedure for this round"
          />
          <RoomProcedureFields
            procedure={procedure}
            handoffInstruction={handoffInstruction}
            showHandoff={false}
            disabled={!customizeProcedure}
            onProcedureChange={setProcedure}
            onHandoffInstructionChange={setHandoffInstruction}
          />
          <FormControlLabel
            control={
              <Checkbox checked={customizeHandoff} onChange={(event) => setCustomizeHandoff(event.target.checked)} />
            }
            label="Customize handoff instruction for this round"
          />
          {customizeHandoff ? (
            <TextField
              size="small"
              multiline
              minRows={2}
              maxRows={5}
              label="Handoff instruction"
              value={handoffInstruction}
              helperText="Optional guidance for the scorekeeper when this game changes hands."
              onChange={(event) => setHandoffInstruction(event.target.value)}
            />
          ) : (
            <Typography variant="caption" color="text.secondary">
              The tournament-wide handoff instruction will be used when one is configured.
            </Typography>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={save} variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RoundProcedureDialog;
