import { IsEnum } from 'class-validator';
import { OrganizationStatus } from '../../common/enums';

export class SetOrganizationStatusDto {
  @IsEnum(OrganizationStatus)
  status: OrganizationStatus;
}
