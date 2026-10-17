import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MinLength,
} from 'class-validator';
import { PayoutAccountType } from '../../common/enums';

export class UpsertPayoutAccountDto {
  @IsEnum(PayoutAccountType)
  type: PayoutAccountType;

  @IsString()
  @Length(1, 255)
  provider: string;

  @IsString()
  @Length(1, 255)
  accountHolderName: string;

  // Optional: on update, omitting this keeps the currently stored account number. Required on
  // create — enforced in OrganizerService.upsertPayoutAccount, since that depends on whether an
  // account already exists, which class-validator can't know on its own.
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'accountNumber must be at least 8 digits' })
  accountNumber?: string;
}