import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { RunnerProfile } from './entities/runner-profile.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateRunnerProfileDto } from './dto/update-runner-profile.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(RunnerProfile)
    private readonly runnerProfilesRepo: Repository<RunnerProfile>,
  ) {}

  async getMe(userId: string) {
    const user = await this.usersRepo.findOne({
      where: { id: userId },
      relations: ['runnerProfile'],
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateMe(userId: string, dto: UpdateUserDto) {
    await this.usersRepo.update(userId, dto);
    return this.getMe(userId);
  }

  async updateMyProfile(userId: string, dto: UpdateRunnerProfileDto) {
    await this.runnerProfilesRepo.update({ userId }, dto);
    return this.getMe(userId);
  }

  // Consumed by AdminModule for GET /admin/users
  async listForAdmin(filters: { role?: string; isActive?: boolean }) {
    const qb = this.usersRepo.createQueryBuilder('user');
    if (filters.role) qb.andWhere('user.role = :role', { role: filters.role });
    if (filters.isActive !== undefined) {
      qb.andWhere('user.isActive = :isActive', { isActive: filters.isActive });
    }
    return qb.getMany();
  }

  async suspend(userId: string, isActive: boolean) {
    await this.usersRepo.update(userId, { isActive });
    return this.getMe(userId);
  }
}
