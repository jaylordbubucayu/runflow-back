import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Admin input for the organizer event-publishing fee. 0 turns the fee off. */
export class SetOrganizerFeeDto {
  /** In pesos, e.g. 499.00. Converted to centavos on the server. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  amountPesos: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}