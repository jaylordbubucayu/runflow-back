import { IsString } from 'class-validator';

export class ResolveQrDto {
  @IsString()
  qrToken: string;
}
