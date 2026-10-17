import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { GuestParticipantDto } from './guest-participant.dto';

export class CreateGuestRegistrationsDto {
  // Used only to find-or-create the shadow user account that owns every registration in this
  // batch (see RegistrationsService.findOrCreateGuestUser) — not stored on each registration
  // (each participant's own name/email are separate fields below, per participant).
  @IsEmail()
  contactEmail: string;

  @IsString()
  contactFirstName: string;

  @IsString()
  contactLastName: string;

  // Capped at 10: a real registration desk, not a bulk-import tool. All participants must belong
  // to categories under the SAME event (enforced in the service) — a "register my team for this
  // race" flow, not a cross-event shopping cart.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => GuestParticipantDto)
  participants: GuestParticipantDto[];
}
