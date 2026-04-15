import { Controller, Get, Post, Body, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { City } from "./cities.entity";
import { CitiesService } from "./cities.service";

@Public()
@Controller("cities")
export class CitiesController {
  constructor(
    @InjectRepository(City)
    private cityRepo: Repository<City>,
    private citiesService: CitiesService
  ) {}

  @Get()
  getAll() {
    return this.cityRepo.find();
  }

  @Post()
  async create(@Body() body) {
    // Removed countryISO field if it was being saved here (not present in this method).
    const city = this.cityRepo.create(body);
    return this.cityRepo.save(city);
  }

  @Get("search")
  search(@Query("q") q: string) {
    return this.citiesService.search(q);
  }

  @Post("save")
  save(
    @Body()
    body: {
      name: string;
      state: string;
      country: string;
      countryISO?: string;
      countryCode?: string;
    },
  ) {
    return this.citiesService.save(body);
  }
}