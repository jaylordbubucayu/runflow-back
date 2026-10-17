import { IsEnum, IsNumber, IsString } from 'class-validator';
import { CheckpointType } from '../../common/enums';

/**
 * One stop in a bulk `POST :id/checkpoints` call (array body) — mirrors the
 * bulk-replace pattern already used by SetPrizeDto/SetFreebieDto. Backs the
 * frontend's route/stops map editor, which sends the organizer's full
 * current stop list on every save.
 */
export class SetCheckpointDto {
  @IsEnum(CheckpointType)
  type: CheckpointType;

  @IsString()
  name: string;

  @IsNumber()
  sequenceOrder: number;

  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;
}
