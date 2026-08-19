/**
 * Add or edit one scheduled pairing.
 *
 * An ordinary YellowFruit edit dialog - the same shape, hotkeys and accept/cancel buttons as the pool
 * and phase dialogs. Three fields, because a pairing is three facts: which round, and which two teams.
 * Validation belongs to ScheduledGameManager, so what is displayed here is whatever that object last
 * concluded rather than a second opinion computed in the component.
 */
import { useContext, useEffect, useRef, useState } from 'react';
import { Alert, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField } from '@mui/material';
import { useHotkeys } from 'react-hotkeys-hook';
import { TournamentContext } from '../TournamentManager';
import useSubscription from '../Utils/CustomHooks';
import { YfAcceptButton, YfCancelButton } from '../Utils/GeneralReactUtils';
import { ScheduledGameModalContext } from '../Modal Managers/ScheduledGameManager';

export default function ScheduledGameEditDialog() {
  const tournManager = useContext(TournamentContext);
  const [, setUpdateNeeded] = useState({});
  const [mgr] = useState(tournManager.scheduledGameManager);
  useEffect(() => {
    mgr.dataChangedReactCallback = () => {
      setUpdateNeeded({});
    };
  }, [mgr]);

  return (
    <ScheduledGameModalContext.Provider value={mgr}>
      <ScheduledGameEditDialogCore />
    </ScheduledGameModalContext.Provider>
  );
}

function ScheduledGameEditDialogCore() {
  const tournManager = useContext(TournamentContext);
  const modalManager = useContext(ScheduledGameModalContext);
  const [isOpen] = useSubscription(modalManager.modalIsOpen);
  const acceptButtonRef = useRef<HTMLButtonElement>(null);

  const hasErrors = modalManager.hasAnyErrors();
  const { phase, round, leftTeam, rightTeam, eligibleTeams, teamsError, roundError, warning, originalGame } =
    modalManager;

  const handleAccept = () => {
    acceptButtonRef.current?.focus();
    tournManager.closeScheduledGameModal(true);
  };
  const handleCancel = () => {
    tournManager.closeScheduledGameModal(false);
  };

  useHotkeys('alt+c', () => handleCancel(), { enabled: isOpen, enableOnFormTags: true });
  useHotkeys('alt+a', () => handleAccept(), { enabled: isOpen && !hasErrors, enableOnFormTags: true });

  const rounds = phase?.rounds ?? [];

  return (
    <Dialog open={isOpen} fullWidth maxWidth="xs" onClose={handleCancel}>
      <DialogTitle>{originalGame ? 'Edit Pairing' : 'Add Pairing'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            select
            size="small"
            label="Round"
            error={roundError !== ''}
            helperText={roundError || undefined}
            value={round ? String(round.number) : ''}
            onChange={(e) => {
              const chosen = rounds.find((rd) => String(rd.number) === e.target.value);
              if (chosen) modalManager.setRound(chosen);
            }}
          >
            {rounds.map((rd) => (
              <MenuItem key={rd.number} value={String(rd.number)}>
                {rd.displayName()}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Team A"
            value={leftTeam?.name ?? ''}
            onChange={(e) =>
              modalManager.setTeam(
                'left',
                eligibleTeams.find((tm) => tm.name === e.target.value),
              )
            }
          >
            {eligibleTeams.map((team) => (
              <MenuItem key={team.id} value={team.name}>
                {team.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Team B"
            value={rightTeam?.name ?? ''}
            onChange={(e) =>
              modalManager.setTeam(
                'right',
                eligibleTeams.find((tm) => tm.name === e.target.value),
              )
            }
          >
            {eligibleTeams.map((team) => (
              <MenuItem key={team.id} value={team.name}>
                {team.name}
              </MenuItem>
            ))}
          </TextField>
          {teamsError !== '' && <Alert severity="error">{teamsError}</Alert>}
          {teamsError === '' && warning !== '' && <Alert severity="warning">{warning}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <YfCancelButton onClick={handleCancel} />
        <YfAcceptButton onClick={handleAccept} disabled={hasErrors} ref={acceptButtonRef} />
      </DialogActions>
    </Dialog>
  );
}
