import { IsString, MinLength } from 'class-validator';

export class PauseAutonomousDto {
  @IsString() @MinLength(1) reason!: string;
}
