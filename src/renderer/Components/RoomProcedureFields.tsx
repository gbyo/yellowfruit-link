import { useEffect, useState } from 'react';
import {
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  IRoomBreak,
  IRoomProcedure,
  ProtestCheckpointPolicy,
  SubstitutionPolicy,
  updateRoomProcedure,
} from '../DataModel/RoomProcedure';

interface IRoomProcedureFieldsProps {
  procedure: IRoomProcedure;
  handoffInstruction: string;
  onProcedureChange: (procedure: IRoomProcedure) => void;
  onHandoffInstructionChange: (instruction: string) => void;
  disabled?: boolean;
  showHandoff?: boolean;
}

function formatBreaks(breaks?: IRoomBreak[]): string {
  return (breaks ?? [])
    .map((roomBreak) => `${roomBreak.afterTossup}${roomBreak.label ? `: ${roomBreak.label}` : ''}`)
    .join(', ');
}

function parseBreaks(value: string): IRoomBreak[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const entries = trimmed.split(',').map((entry) => entry.trim());
  const parsed: IRoomBreak[] = [];
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const tossupText = colon < 0 ? entry : entry.slice(0, colon).trim();
    const afterTossup = Number(tossupText);
    if (!Number.isInteger(afterTossup) || afterTossup < 1) return undefined;
    const label = colon < 0 ? '' : entry.slice(colon + 1).trim();
    parsed.push({ afterTossup, ...(label ? { label } : {}) });
  }
  return parsed;
}

function RoomProcedureFields(props: IRoomProcedureFieldsProps) {
  const {
    procedure,
    handoffInstruction,
    onProcedureChange,
    onHandoffInstructionChange,
    disabled = false,
    showHandoff = true,
  } = props;
  const [breakDraft, setBreakDraft] = useState(formatBreaks(procedure.breaks));

  useEffect(() => {
    setBreakDraft(formatBreaks(procedure.breaks));
  }, [procedure.breaks]);

  const update = (patch: Partial<IRoomProcedure>) => onProcedureChange(updateRoomProcedure(procedure, patch));

  const commitBreaks = () => {
    const parsed = parseBreaks(breakDraft);
    if (parsed === undefined) {
      setBreakDraft(formatBreaks(procedure.breaks));
      return;
    }
    update({ breaks: parsed });
  };

  return (
    <Stack spacing={1.5}>
      <FormControlLabel
        label="Play in halves"
        control={
          <Switch
            checked={procedure.halves}
            disabled={disabled}
            onChange={(event) =>
              event.target.checked
                ? update({ halves: true })
                : update({ halves: false, breaks: undefined, halfLengthMinutes: undefined })
            }
          />
        }
      />
      {procedure.halves && (
        <Stack spacing={1.5}>
          <TextField
            size="small"
            type="number"
            label="Half length (minutes)"
            value={procedure.halfLengthMinutes ?? ''}
            disabled={disabled}
            inputProps={{ min: 1, max: 240 }}
            onChange={(event) =>
              update({ halfLengthMinutes: event.target.value ? Number(event.target.value) : undefined })
            }
          />
          <TextField
            size="small"
            label="Breaks after tossups"
            value={breakDraft}
            disabled={disabled}
            placeholder="10: Halftime"
            helperText="Comma-separated tossups; add an optional label after a colon."
            onChange={(event) => setBreakDraft(event.target.value)}
            onBlur={commitBreaks}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitBreaks();
            }}
          />
        </Stack>
      )}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          size="small"
          type="number"
          label="Timeouts per team"
          value={procedure.timeoutsPerTeam}
          disabled={disabled}
          inputProps={{ min: 0, max: 99 }}
          onChange={(event) => update({ timeoutsPerTeam: event.target.value ? Number(event.target.value) : 0 })}
        />
        <TextField
          size="small"
          type="number"
          label="Timeout length (seconds)"
          value={procedure.timeoutDurationSeconds ?? ''}
          disabled={disabled || procedure.timeoutsPerTeam === 0}
          inputProps={{ min: 1, max: 3600 }}
          onChange={(event) =>
            update({ timeoutDurationSeconds: event.target.value ? Number(event.target.value) : undefined })
          }
        />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <FormControl size="small" fullWidth disabled={disabled}>
          <InputLabel id="room-procedure-protest-label">Protest checkpoints</InputLabel>
          <Select
            labelId="room-procedure-protest-label"
            label="Protest checkpoints"
            value={procedure.protestCheckpoints ?? ''}
            onChange={(event) =>
              update({ protestCheckpoints: (event.target.value || undefined) as ProtestCheckpointPolicy | undefined })
            }
          >
            <MenuItem value="">Not specified</MenuItem>
            <MenuItem value="none">None</MenuItem>
            <MenuItem value="phase-boundaries">Phase boundaries</MenuItem>
            <MenuItem value="strict-overtime">Strict overtime</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" fullWidth disabled={disabled}>
          <InputLabel id="room-procedure-substitution-label">Substitution policy</InputLabel>
          <Select
            labelId="room-procedure-substitution-label"
            label="Substitution policy"
            value={procedure.substitutionPolicy ?? ''}
            onChange={(event) =>
              update({ substitutionPolicy: (event.target.value || undefined) as SubstitutionPolicy | undefined })
            }
          >
            <MenuItem value="">Not specified</MenuItem>
            <MenuItem value="any-boundary">Any boundary</MenuItem>
            <MenuItem value="breaks-timeouts-overtime">Breaks, timeouts, and overtime</MenuItem>
          </Select>
        </FormControl>
      </Stack>
      {showHandoff && (
        <TextField
          size="small"
          multiline
          minRows={2}
          maxRows={5}
          label="Handoff instruction"
          value={handoffInstruction}
          disabled={disabled}
          helperText="Optional guidance for the scorekeeper when this game changes hands."
          onChange={(event) => onHandoffInstructionChange(event.target.value)}
        />
      )}
      <Typography variant="caption" color="text.secondary">
        The procedure is sent with each new room assignment; changing these defaults does not rewrite an assignment
        already in progress.
      </Typography>
    </Stack>
  );
}

RoomProcedureFields.defaultProps = {
  disabled: false,
  showHandoff: true,
};

export default RoomProcedureFields;
