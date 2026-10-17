import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { OrganizerFeeService } from './organizer-fee.service';
import { CreateOrganizerFeeDto } from './dto/create-organizer-fee.dto';
import { UpdateOrganizerFeeDto } from './dto/update-organizer-fee.dto';

@Controller('organizer-fee')
export class OrganizerFeeController {
  constructor(private readonly organizerFeeService: OrganizerFeeService) {}

  // @Post()
  // create(@Body() createOrganizerFeeDto: CreateOrganizerFeeDto) {
  //   return this.organizerFeeService.create(createOrganizerFeeDto);
  // }

  // @Get()
  // findAll() {
  //   return this.organizerFeeService.findAll();
  // }

  // @Get(':id')
  // findOne(@Param('id') id: string) {
  //   return this.organizerFeeService.findOne(+id);
  // }

  // @Patch(':id')
  // update(@Param('id') id: string, @Body() updateOrganizerFeeDto: UpdateOrganizerFeeDto) {
  //   return this.organizerFeeService.update(+id, updateOrganizerFeeDto);
  // }

  // @Delete(':id')
  // remove(@Param('id') id: string) {
  //   return this.organizerFeeService.remove(+id);
  // }
}
