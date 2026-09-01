import { useContext } from 'react';
import { Typography } from '@mui/material';
import { TournamentContext } from '../TournamentManager';
import useSubscription from '../Utils/CustomHooks';
import YfCard from './YfCard';
import RoomProcedureFields from './RoomProcedureFields';

function RoomProcedureSettingsCard() {
  const tournManager = useContext(TournamentContext);
  const [procedure, setProcedure] = useSubscription(tournManager.tournament.roomProcedure);
  const [handoffInstruction, setHandoffInstruction] = useSubscription(tournManager.tournament.handoffInstruction ?? '');
  const readOnly = tournManager.tournament.hasMatchData;

  return (
    <YfCard title="Room procedure defaults">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        These neutral room instructions apply to every round unless a round has its own override.
      </Typography>
      <RoomProcedureFields
        procedure={procedure}
        handoffInstruction={handoffInstruction}
        disabled={readOnly}
        onProcedureChange={(nextProcedure) => {
          setProcedure(nextProcedure);
          tournManager.tournament.setRoomProcedure(nextProcedure);
          tournManager.dataChangedReactCallback();
        }}
        onHandoffInstructionChange={(nextInstruction) => {
          setHandoffInstruction(nextInstruction);
          tournManager.tournament.setHandoffInstruction(nextInstruction);
          tournManager.dataChangedReactCallback();
        }}
      />
    </YfCard>
  );
}

export default RoomProcedureSettingsCard;
