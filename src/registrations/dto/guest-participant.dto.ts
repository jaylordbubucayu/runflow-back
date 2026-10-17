import { CreateRegistrationDto } from './create-registration.dto';

// Same shape as a normal registration's participant details — guests fill in exactly the same
// form fields per person, just without being logged in.
export class GuestParticipantDto extends CreateRegistrationDto {}
