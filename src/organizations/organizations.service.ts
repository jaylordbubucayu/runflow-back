import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { Organization } from './entities/organization.entity';
import { OrganizationStatus, UserRole } from '../common/enums';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { User } from '../users/entities/user.entity';

/** Max logo size. Keep in sync with the limit passed to FileInterceptor and the frontend (5 MB). */
export const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/** Folder under the uploads root, and the URL segment it is served from. */
const LOGO_DIR_NAME = 'organization-logos';

type LogoFile = { buffer: Buffer; size: number };

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  /** Absolute folder logos are written to. Override the root with UPLOADS_DIR. */
  private readonly logoDir = join(
    process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads'),
    LOGO_DIR_NAME,
  );

  /** Public base URL of this API, used to build the stored logo URL. */
  private readonly publicBaseUrl = (
    process.env.API_PUBLIC_URL ?? 'http://localhost:3000'
  ).replace(/\/$/, '');

  constructor(
    @InjectRepository(Organization)
    private readonly orgsRepo: Repository<Organization>,
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
  ) {}

  /**
   * Creates the organization AND promotes the calling user to ORGANIZER.
   * Previously nothing in the API ever changed a user's role away from the
   * RUNNER default set at registration — there was no way for anyone to
   * become an organizer at all. "Create your organization" is the natural,
   * and now only, self-service path to the organizer role, matching how
   * OrganizationOwnerGuard already expects `user.role === ORGANIZER`.
   */
  async createOrganization(ownerUserId: string, dto: CreateOrganizationDto) {
    const org = this.orgsRepo.create({
      ownerUserId,
      ...dto,
      status: OrganizationStatus.PENDING,
    });
    const saved = await this.orgsRepo.save(org);

    await this.usersRepo.update(ownerUserId, { role: UserRole.ORGANIZER });

    return saved;
  }

  async updateProfile(orgId: string, dto: UpdateOrganizationDto) {
    await this.orgsRepo.update(orgId, dto);
    return this.getBySlugOrId(orgId);
  }

  async getBySlugOrId(idOrSlug: string) {
    // NOTE: schema currently has no `slug` column - add one if you want
    // pretty public organizer URLs; falling back to id lookup for now.
    const org = await this.orgsRepo.findOne({ where: { id: idOrSlug } });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /** Used by GET /organizations/mine — there was previously no way for the
   * frontend to discover its own organization id after login. */
  async getByOwner(ownerUserId: string) {
    const org = await this.orgsRepo.findOne({ where: { ownerUserId } });
    if (!org) throw new NotFoundException("You don't have an organization yet");
    return org;
  }

  async listForAdmin(filters: { status?: OrganizationStatus }) {
    const qb = this.orgsRepo.createQueryBuilder('org');
    if (filters.status) {
      qb.andWhere('org.status = :status', { status: filters.status });
    }
    return qb.getMany();
  }

  async setStatus(orgId: string, status: OrganizationStatus) {
    await this.orgsRepo.update(orgId, { status });
    return this.getBySlugOrId(orgId);
  }

  /* ------------------------------------------------------------------ */
  /* Organization logo                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Stores a new logo and returns the updated organization.
   * The previous file is only deleted after the new one is saved, so a
   * failed upload never loses the existing logo.
   */
  async uploadLogo(orgId: string, userId: string, file?: LogoFile) {
    const org = await this.getOwnedOrganization(orgId, userId);

    if (!file?.buffer?.length) {
      throw new BadRequestException('No logo file was uploaded.');
    }
    if (file.size > MAX_LOGO_BYTES) {
      throw new BadRequestException('The logo must be 5 MB or smaller.');
    }

    // Trust the file's bytes, not the client-supplied mimetype or filename.
    const ext = this.detectImageExtension(file.buffer);
    if (!ext) {
      throw new BadRequestException('The logo must be a PNG, JPG or WebP image.');
    }

    const filename = `${org.id}-${randomUUID()}.${ext}`;
    await fs.mkdir(this.logoDir, { recursive: true });
    await fs.writeFile(join(this.logoDir, filename), file.buffer);

    const previousUrl = org.logoUrl;
    try {
      await this.orgsRepo.update(org.id, {
        logoUrl: `${this.publicBaseUrl}/uploads/${LOGO_DIR_NAME}/${filename}`,
      });
    } catch (err) {
      await this.deleteFile(filename); // don't leave an orphan behind
      throw err;
    }

    await this.deleteStoredLogo(previousUrl);
    return this.getBySlugOrId(org.id);
  }

  /** Clears the logo and deletes the stored file. Other profile data is untouched. */
  async removeLogo(orgId: string, userId: string) {
    const org = await this.getOwnedOrganization(orgId, userId);
    const previousUrl = org.logoUrl;

    // Requires `logoUrl: string | null` on the entity (see notes).
    await this.orgsRepo.update(org.id, { logoUrl: null });

    await this.deleteStoredLogo(previousUrl);
    return this.getBySlugOrId(org.id);
  }

  /** Loads the org and ensures the caller owns it. */
  private async getOwnedOrganization(orgId: string, userId: string) {
    const org = await this.getBySlugOrId(orgId);
    if (String(org.ownerUserId) !== String(userId)) {
      throw new ForbiddenException('You can only manage your own organization.');
    }
    return org;
  }

  /** Returns a file extension from the image's magic bytes, or null if unsupported. */
  private detectImageExtension(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
    if (
      buf.length >= 8 &&
      buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'png';
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return 'jpg';
    }
    if (
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return 'webp';
    }
    return null;
  }

  /** Deletes a logo file only if the URL points at our own logo folder. */
  private async deleteStoredLogo(url?: string | null) {
    if (!url || !url.includes(`/uploads/${LOGO_DIR_NAME}/`)) return;
    await this.deleteFile(basename(url));
  }

  private async deleteFile(filename: string) {
    try {
      // basename() above prevents path traversal out of the logo folder.
      await fs.unlink(join(this.logoDir, basename(filename)));
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        this.logger.warn(`Could not delete logo file ${filename}: ${err?.message}`);
      }
    }
  }
}