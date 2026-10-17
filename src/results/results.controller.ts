import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { ResultsService } from './results.service';
import { ImportResultRowDto } from './dto/import-result-row.dto';
import { SetPlaceByBibRowDto, SetPlaceDto } from './dto/set-place.dto';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller()
export class ResultsController {
  constructor(private readonly resultsService: ResultsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post('events/:id/results/import')
  importResults(
    @Param('id') eventId: string,
    @Body() rows: ImportResultRowDto[],
  ) {
    return this.resultsService.importResults(eventId, rows);
  }

  @UseGuards(JwtAuthGuard)
  @Get('results/:registrationId')
  getResult(@Param('registrationId') registrationId: string) {
    return this.resultsService.getResultForRunner(registrationId);
  }

  @Get('events/:id/leaderboard')
  getEventLeaderboard(
    @Param('id') eventId: string,
    @Query('scope') scope?: 'overall' | 'category' | 'age_group' | 'gender',
    @Query('categoryId') categoryId?: string,
  ) {
    return this.resultsService.getEventLeaderboard(eventId, {
      scope,
      categoryId,
    });
  }

  @Get('leaderboard/global')
  getGlobalLeaderboard(@Query('by') by?: 'distance' | 'events' | 'fastest') {
    return this.resultsService.getGlobalLeaderboard({ by });
  }

  // Set the place for one runner: PATCH /events/:id/results/bib/101/place
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Patch('events/:id/results/bib/:bibNumber/place')
  setPlace(
    @Param('id') eventId: string,
    @Param('bibNumber') bibNumber: string,
    @Body() dto: SetPlaceDto,
  ) {
    return this.resultsService.setPlaceByBib(eventId, bibNumber, dto);
  }

  // Set places for many runners at once: PATCH /events/:id/results/places
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Patch('events/:id/results/places')
  setPlaces(
    @Param('id') eventId: string,
    @Body() rows: SetPlaceByBibRowDto[],
  ) {
    return this.resultsService.setPlacesByBib(eventId, rows);
  }


  // POST /events/:id/results/import-file?dryRun=true  (multipart, field name "file")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ORGANIZER)
  @Post('events/:id/results/import-file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  importFile(
    @Param('id') eventId: string,
    //@ts-ignore
    @UploadedFile() file: Express.Multer.File,
    @Query('dryRun') dryRun?: string,
  ) {
    if (!file) throw new BadRequestException('Upload a CSV in the "file" field');
    return this.resultsService.importFromTimingFile(eventId, file.buffer, {
      dryRun: dryRun === 'true',
    });
  }
  
}
