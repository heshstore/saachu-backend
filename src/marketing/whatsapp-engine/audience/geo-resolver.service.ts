import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { City } from '../../../cities/cities.entity';
import { GeoCorrection, isGarbageCity, isMeaningfulGeo } from './geo-quality.util';

export type GeoSource = 'local' | 'google_places' | 'google_geocoding' | null;

export type ResolvedGeo = {
  city: string | null;
  state: string | null;
  country: string | null;
  source: GeoSource;
  resolved: boolean;
  corrections: GeoCorrection[];
};

/**
 * City-first geographic resolver for Promotional DB imports.
 *
 * Resolution order (when ENABLE_GOOGLE_GEO=true):
 *   1. cities table (exact → fuzzy)
 *   2. Google Places Text Search  [disabled until ENABLE_GOOGLE_GEO]
 *   3. Google Geocoding API       [disabled until ENABLE_GOOGLE_GEO]
 *
 * Imported state/country are never stored when they conflict with verified geography.
 */
@Injectable()
export class GeoResolverService {
  private readonly logger = new Logger(GeoResolverService.name);
  private readonly googleEnabled = process.env.ENABLE_GOOGLE_GEO === 'true';

  constructor(
    @InjectRepository(City)
    private readonly cityRepo: Repository<City>,
  ) {}

  async resolve(
    city: string | null | undefined,
    importedState: string | null | undefined,
    importedCountry: string | null | undefined,
  ): Promise<ResolvedGeo> {
    const empty: ResolvedGeo = {
      city: isMeaningfulGeo(city) ? city!.trim() : null,
      state: null,
      country: null,
      source: null,
      resolved: false,
      corrections: [],
    };

    if (!isMeaningfulGeo(city)) return empty;
    if (isGarbageCity(city)) {
      return { ...empty, city: city!.trim(), resolved: false };
    }

    const local = await this._resolveLocal(city!.trim());
    if (local) {
      return this._applyVerified(
        local.name,
        local.state,
        local.country,
        'local',
        importedState,
        importedCountry,
      );
    }

    if (this.googleEnabled) {
      // Architecture ready — live Google calls gated behind ENABLE_GOOGLE_GEO.
      const places = await this._resolveGooglePlaces(city!.trim());
      if (places) {
        return this._applyVerified(
          places.city,
          places.state,
          places.country,
          'google_places',
          importedState,
          importedCountry,
        );
      }
      const geocoded = await this._resolveGoogleGeocoding(city!.trim());
      if (geocoded) {
        return this._applyVerified(
          geocoded.city,
          geocoded.state,
          geocoded.country,
          'google_geocoding',
          importedState,
          importedCountry,
        );
      }
    }

    return {
      city: city!.trim(),
      state: null,
      country: null,
      source: null,
      resolved: false,
      corrections: [],
    };
  }

  /** Batch dedupe — one DB/API lookup per distinct city string per import. */
  async resolveBatch(
    rows: { city?: string | null; state?: string | null; country?: string | null }[],
  ): Promise<Map<number, ResolvedGeo>> {
    const cache = new Map<string, ResolvedGeo>();
    const out = new Map<number, ResolvedGeo>();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const key = (r.city ?? '').trim().toLowerCase();
      if (!key) {
        out.set(i, await this.resolve(r.city, r.state, r.country));
        continue;
      }
      if (!cache.has(key)) {
        cache.set(key, await this.resolve(r.city, r.state, r.country));
      }
      out.set(i, cache.get(key)!);
    }
    return out;
  }

  private async _resolveLocal(cityName: string): Promise<City | null> {
    const exact = await this.cityRepo.findOne({
      where: { name: ILike(cityName) },
    });
    if (exact) return exact;

    const fuzzy = await this.cityRepo.find({
      where: { name: ILike(`%${cityName}%`) },
      take: 1,
    });
    return fuzzy[0] ?? null;
  }

  /** Stub — wire Google Places Text Search when ENABLE_GOOGLE_GEO=true. */
  private async _resolveGooglePlaces(_city: string): Promise<{ city: string; state: string; country: string } | null> {
    this.logger.debug('Google Places resolution skipped (ENABLE_GOOGLE_GEO not enabled)');
    return null;
  }

  /** Stub — wire Geocoding API when ENABLE_GOOGLE_GEO=true. */
  private async _resolveGoogleGeocoding(_city: string): Promise<{ city: string; state: string; country: string } | null> {
    this.logger.debug('Google Geocoding resolution skipped (ENABLE_GOOGLE_GEO not enabled)');
    return null;
  }

  private _applyVerified(
    city: string,
    state: string,
    country: string,
    source: GeoSource,
    importedState: string | null | undefined,
    importedCountry: string | null | undefined,
  ): ResolvedGeo {
    const corrections: GeoCorrection[] = [];

    if (isMeaningfulGeo(importedState) && importedState!.trim().toLowerCase() !== state.trim().toLowerCase()) {
      corrections.push({
        field: 'state',
        imported: importedState!.trim(),
        resolved: state,
        source: source ?? 'local',
        action: 'TRUST_VERIFIED',
      });
    }
    if (isMeaningfulGeo(importedCountry) && importedCountry!.trim().toLowerCase() !== country.trim().toLowerCase()) {
      corrections.push({
        field: 'country',
        imported: importedCountry!.trim(),
        resolved: country,
        source: source ?? 'local',
        action: 'TRUST_VERIFIED',
      });
    }

    return {
      city,
      state,
      country,
      source,
      resolved: true,
      corrections,
    };
  }
}
