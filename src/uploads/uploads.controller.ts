import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { extname, join } from 'path';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/enums';

export const UPLOADS_DIR = join(process.cwd(), 'uploads');
const MAX_FILES = 3;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per image
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/**
 * Image upload for event banners. Organizer-only, same guard pattern as event creation.
 *
 * Files are stored on local disk under UPLOADS_DIR and served back statically at `/uploads/...`
 * (registered in main.ts via useStaticAssets, outside the `/api` prefix). This is a plain
 * single-server setup; if RunFlow ever runs on more than one app server, this directory needs to
 * move to shared/object storage (S3 or similar) instead, since each instance would otherwise
 * only see files uploaded to itself.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ORGANIZER)
@Controller('uploads')
export class UploadsController {
  @Post('images')
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES, {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          if (!existsSync(UPLOADS_DIR)) {
            mkdirSync(UPLOADS_DIR, { recursive: true });
          }
          cb(null, UPLOADS_DIR);
        },
        filename: (_req, file, cb) => {
          cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
        },
      }),
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
      fileFilter: (_req, file, cb) => {
        // Checks the client-declared mimetype AND the file extension. Neither is proof of actual
        // file content (a client can lie about both), but requiring both to agree is a cheap
        // improvement over trusting either alone; it is not a substitute for real magic-byte
        // sniffing if these images are ever served somewhere script execution would matter.
        const ext = extname(file.originalname).toLowerCase();
        if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
          cb(new BadRequestException('Only JPEG, PNG, WebP or GIF images are allowed'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadImages(
    //@ts-ignore
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request,
  ): { urls: string[] } {
    if (!files?.length) {
      throw new BadRequestException('Attach at least one image (field name "files")');
    }
    // Absolute URLs (built from the incoming request) so the frontend can use them as-is,
    // exactly like an organizer-pasted bannerUrl — no separate "asset host" config needed.
    const origin = `${req.protocol}://${req.get('host')}`;
    const urls = files.map((f) => `${origin}/uploads/${f.filename}`);
    return { urls };
  }
}