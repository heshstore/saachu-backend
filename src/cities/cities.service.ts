import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { City } from './cities.entity';

@Injectable()
export class CitiesService {
  private readonly _cache = new Map<string, { data: City[]; ts: number }>();

  constructor(
    @InjectRepository(City)
    private repo: Repository<City>,
  ) {}

  async search(query: string) {
    if (!query) return [];

    const key = query.toLowerCase();
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.ts < 600_000) return hit.data;

    const localResults = await this.repo.find({
      where: [
        { name: ILike(`%${query}%`) },
        { state: ILike(`%${query}%`) },
        { country: ILike(`%${query}%`) },
      ],
      take: 10,
      select: ['id', 'name', 'state', 'country', 'countryISO', 'countryCode'],
    });

    this._cache.set(key, { data: localResults, ts: Date.now() });
    return localResults;
  }

  async save(dto: {
    name: string;
    state: string;
    country: string;
    countryISO?: string;
    countryCode?: string;
  }) {
    // Prevent duplicate cities (case-insensitive name + state + country)
    const existing = await this.repo.findOne({
      where: {
        name: ILike(dto.name),
        state: ILike(dto.state),
        country: ILike(dto.country),
      },
    });

    if (existing) {
      // Backfill missing codes on existing record
      if (
        (!existing.countryISO && dto.countryISO) ||
        (!existing.countryCode && dto.countryCode)
      ) {
        await this.repo.update(existing.id, {
          countryISO: existing.countryISO || dto.countryISO,
          countryCode: existing.countryCode || dto.countryCode,
        });
        return {
          ...existing,
          countryISO: dto.countryISO,
          countryCode: dto.countryCode,
        };
      }
      return existing;
    }

    const city = this.repo.create({
      name: dto.name,
      state: dto.state,
      country: dto.country,
      countryISO: dto.countryISO || null,
      countryCode: dto.countryCode || null,
    });

    return this.repo.save(city);
  }
}
