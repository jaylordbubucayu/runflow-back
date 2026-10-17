import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { MAX_LOGO_BYTES, OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { User } from '../users/entities/user.entity';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateOrganizationDto) {
    return this.organizationsService.createOrganization(user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mine')
  getMine(@CurrentUser() user: User) {
    return this.organizationsService.getByOwner(user.id);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.organizationsService.getBySlugOrId(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateOrganizationDto) {
    return this.organizationsService.updateProfile(id, dto);
  }

  /** multipart/form-data, field name "logo". Returns the updated organization (incl. logoUrl). */
  @UseGuards(JwtAuthGuard)
  @Post(':id/logo')
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
    }),
  )
  uploadLogo(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.organizationsService.uploadLogo(id, user.id, file);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id/logo')
  removeLogo(@Param('id') id: string, @CurrentUser() user: User) {
    return this.organizationsService.removeLogo(id, user.id);
  }
}