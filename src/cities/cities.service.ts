import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, ILike } from "typeorm";
import { City } from "./cities.entity";

@Injectable()
export class CitiesService {
  constructor(
    @InjectRepository(City)
    private repo: Repository<City>,
  ) {}

  async search(query: string) {
    if (!query) return [];

    // Only search by name, and only in the DB.
    // Never call Google or combine Google results here.
    const localResults = await this.repo.find({
      where: {
        name: ILike(`%${query}%`),
      },
      take: 10,
    });

    return localResults;
  }

  async save(dto: any) {
    console.log("DTO RECEIVED:", dto);

    // Prevent duplicate cities (case insensitive)
    const existing = await this.repo.findOne({
      where: {
        name: ILike(dto.name),
        state: ILike(dto.state),
        country: ILike(dto.country),
      },
    });

    if (existing) return existing;

    const city = this.repo.create({
      name: dto.name,
      state: dto.state,
      country: dto.country,
    });

    return this.repo.save(city);
  }
}