import {
  IsDateString,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Same registrant fields as the authenticated create-registration DTO.
 * Kept as a separate class (rather than reusing/extending the authenticated
 * DTO) so the two endpoints can evolve independently — the guest endpoint is
 * unauthenticated and public, so its validation surface is worth keeping
 * deliberately explicit.
 */
export class GuestRegistrationDto {
  @IsUUID()
  eventId: string;

  @IsUUID()
  categoryId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @IsDateString()
  birthday: string;

  @IsIn(['male', 'female', 'other'])
  gender: string;

  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'mobileNumber must be a valid phone number',
  })
  mobileNumber: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  emergencyContactName: string;

  @Matches(/^\+?[0-9]{7,15}$/, {
    message: 'emergencyContactNumber must be a valid phone number',
  })
  emergencyContactNumber: string;

  @IsIn(['XS', 'S', 'M', 'L', 'XL', 'XXL'])
  shirtSize: string;
}