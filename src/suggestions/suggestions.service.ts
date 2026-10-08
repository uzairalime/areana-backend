import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma';
import { CreateVenueSuggestionDto } from './dto';

@Injectable()
export class SuggestionsService {
  constructor(private prisma: PrismaService) {}

  create(userId: string, dto: CreateVenueSuggestionDto) {
    return this.prisma.venueSuggestion.create({
      data: { suggestedById: userId, ...dto },
    });
  }

  /** Called by the admin module (permissions verified there). */
  listSuggestions(status?: string) {
    return this.prisma.venueSuggestion.findMany({
      where: status ? { status } : {},
      include: { suggestedBy: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Called by the admin module (permissions verified there). */
  async setStatus(id: string, status: string) {
    const suggestion = await this.prisma.venueSuggestion.findUnique({ where: { id } });
    if (!suggestion) throw new NotFoundException('Suggestion not found');
    return this.prisma.venueSuggestion.update({ where: { id }, data: { status } });
  }
}
