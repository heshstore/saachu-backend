import { Controller, Get, Post, Body, Query } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { City } from "./cities.entity";
import { CitiesService } from "./cities.service";

@Controller("cities")
export class CitiesController {
  constructor(
    @InjectRepository(City)
    private cityRepo: Repository<City>,
    private citiesService: CitiesService
  ) {}

  @Public()
  @Get()
  getAll() {
    return this.cityRepo.find();
  }

  @Post()
  async create(
    @Body() body: { name: string; state: string; country: string; countryISO?: string; countryCode?: string },
  ) {
    const city = this.cityRepo.create({
      name:        body.name,
      state:       body.state,
      country:     body.country,
      countryISO:  body.countryISO,
      countryCode: body.countryCode,
    });
    return this.cityRepo.save(city);
  }

  @Public()
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
