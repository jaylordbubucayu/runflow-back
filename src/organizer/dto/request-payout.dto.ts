import { IsInt, IsOptional, Min } from 'class-validator';

export class RequestPayoutDto {
  /**
   * Amount to withdraw, in centavos. Omit to withdraw the whole available balance.
   * The server re-checks it against the real balance either way.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  amountCentavos?: number;
}
