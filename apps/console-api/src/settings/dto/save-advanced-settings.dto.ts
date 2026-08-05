import { IsIn, IsInt, Max, Min } from 'class-validator';

export class SaveAdvancedSettingsDto {
  @IsInt() @Min(1) @Max(5) maxFollowups!: number;
  @IsInt() @Min(3) @Max(14) minDaysBetweenFollowups!: number;
  @IsIn(['Low', 'Medium', 'High']) sentimentConfidenceFloor!: 'Low' | 'Medium' | 'High';
}
