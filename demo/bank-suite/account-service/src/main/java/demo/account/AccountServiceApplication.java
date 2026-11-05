package demo.account;

import demo.common.Iban;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@SpringBootApplication
@RestController
public class AccountServiceApplication {

    @Value("${demo.greeting:merhaba}")
    private String greeting;

    public static void main(String[] args) {
        SpringApplication.run(AccountServiceApplication.class, args);
    }

    @GetMapping("/iban")
    public Map<String, String> iban() {
        return Map.of("greeting", greeting, "iban", Iban.mask("TR330006100519786457841326"));
    }
}
