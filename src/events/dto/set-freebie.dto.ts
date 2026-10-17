import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class SetFreebieDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsBoolean()
  isCustom?: boolean;
}
