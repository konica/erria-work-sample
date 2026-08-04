import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class IncomingAccountDto {
  @IsString() externalRef!: string;
  @IsString() companyName!: string;
  @IsString() segment!: string;
  @IsString() hub!: string;
  @IsInt() @Min(0) @Max(100) icpScore!: number;
  @IsIn(['high', 'med', 'low']) icpBand!: 'high' | 'med' | 'low';
  @IsString() relationshipSummary!: string;
}

export class IncomingVesselDto {
  @IsString() name!: string;
  @IsString() imo!: string;
  @IsString() flag!: string;
}

export class IncomingTriggerDto {
  @ValidateNested() @Type(() => IncomingAccountDto) account!: IncomingAccountDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => IncomingVesselDto)
  vessel?: IncomingVesselDto;

  @IsString() category!: string;
  @IsString() description!: string;
  @IsIn(['crm', 'class_records', 'public_data', 'buyer_reply'])
  source!: 'crm' | 'class_records' | 'public_data' | 'buyer_reply';
  @IsIn(['high', 'mid', 'low']) confidenceLabel!: 'high' | 'mid' | 'low';
  @IsString() verifiabilityNote!: string;
  @IsISO8601() detectedAt!: string;
  @IsBoolean() hasComplianceDeadlineContent!: boolean;
}
