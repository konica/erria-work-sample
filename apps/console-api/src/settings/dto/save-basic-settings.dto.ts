import { IsInt, Max, Min } from 'class-validator';

export class SaveBasicSettingsDto {
  @IsInt() @Min(1) @Max(4) tier1PromotionThreshold!: number;
  @IsInt() @Min(0) @Max(100) tier1AuditSampleRate!: number;
}
