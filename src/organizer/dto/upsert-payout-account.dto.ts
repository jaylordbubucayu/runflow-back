import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
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

  // BIC of the destination bank / e-wallet, as listed by PayMongo's "Get Receiving Institutions"
  // (8 or 11 characters, e.g. BNORPHMMXXX). Optional so existing clients keep working, but
  // payouts are refused until it is set.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/, {
    message: 'bankCode must be an 8 or 11 character BIC',
  })
  bankCode?: string;
}